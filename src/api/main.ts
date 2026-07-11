// Production entrypoint. Wires the App to real infrastructure from the environment
// and runs it under the StayServer lifecycle (boot-rehydrate + flush-after-write).
//
// Reads / writes are split along the deployed architecture:
//   • WRITES go through the persist-world Edge Function (service-role), which
//     projects server-side in one transaction — the sanctioned write arm.
//   • READS (cold-start rehydration) come straight from Postgres via `pg`.
//
// Env:
//   PORT                        listen port (default 8080)
//   JWT_SECRET                  HS256 signing secret for JwtAuthenticator (REQUIRED)
//   SUPABASE_FUNCTIONS_URL      e.g. https://<ref>.supabase.co/functions/v1 (writes)
//   SUPABASE_SERVICE_ROLE_KEY   service-role JWT the edge function requires (writes)
//   DATABASE_URL                Postgres connection string (reads / boot)
//   BOOT_TENANTS                comma-separated tenant ids to rehydrate; if unset and
//                               DATABASE_URL is present, all tenants are enumerated
//   FLUSH_DEBOUNCE_MS           default 1500
//   PERIODIC_FLUSH_MS           default 30000
//
// This module is the deployment shell — the kernel stays zero-runtime-dependency;
// `pg` is an optional peer only used here (and only if DATABASE_URL is set).

import { App } from './app.ts';
import { StayServer } from './server.ts';
import { JwtAuthenticator } from './context.ts';
import { defaultAdapterRegistry } from '../adapter-registry.ts';
import { defaultObservability, type LogLevel } from '../observability.ts';
import { edgePersistenceBackend, type PersistenceBackend } from '../persistence/edge-client.ts';
import { PgQueryExecutor, Repositories } from '../persistence/repository.ts';
import type { WorldReader } from './app.ts';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env ${name}`);
  return v;
}

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 8080);

  // Auth — a real JWT verifier over the platform's signing secret (the SAME claim
  // the DB RLS keys off). No secret → refuse to start (never silently insecure).
  const authenticator = new JwtAuthenticator({ secret: required('JWT_SECRET') });

  // Write arm: the persist-world Edge Function (service-role). Optional — without it
  // the process runs in-memory only (fine for a smoke test, not for durability).
  let persistence: PersistenceBackend | undefined;
  if (process.env.SUPABASE_FUNCTIONS_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    persistence = edgePersistenceBackend({
      functionsUrl: process.env.SUPABASE_FUNCTIONS_URL,
      serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    });
  }

  // Read arm: Postgres for cold-start rehydration. Optional — without it we boot
  // from empty (a brand-new deployment). RESILIENT BY DESIGN: an unreachable or
  // misconfigured DATABASE_URL must never crash-loop the whole service into a 502
  // — the reader is only the RELOAD path (writes flush through the edge function
  // regardless), so on failure we log the exact reason, surface it on GET /health
  // as rehydration:"degraded: …", and serve anyway. Fix the URL, restart, and
  // /health flips to rehydration:"ok".
  let reader: WorldReader | undefined;
  let tenantIds: string[] = [];
  let rehydration = 'disabled (no DATABASE_URL)';
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    try {
      const executor = new PgQueryExecutor(dbUrl);
      tenantIds = process.env.BOOT_TENANTS
        ? process.env.BOOT_TENANTS.split(',').map((s) => s.trim()).filter(Boolean)
        : (await executor.query({ text: 'select id from tenant order by id', values: [] })).map((r) => String(r['id']));
      reader = { loadWorld: (tenantId: string) => new Repositories(executor, tenantId).loadWorld() };
      rehydration = tenantIds.length > 0 ? `pending (${tenantIds.length} tenant(s))` : 'ok (no tenants yet)';
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      reader = undefined;
      tenantIds = [];
      rehydration = `degraded: ${reason}`;
      console.error(
        `BOOT DEGRADED: DATABASE_URL is set but unreachable (${reason}). ` +
          'Serving WITHOUT cold-start rehydration — durable writes still flow through the edge function. ' +
          'Hint: on Fly/serverless use the Supabase CONNECTION POOLER string (…pooler.supabase.com, user postgres.<ref>), ' +
          'not the IPv6-only direct db.<ref>.supabase.co host, and URL-encode special characters in the password.',
      );
    }
  }

  // Auth config for the portal login screen. With SUPABASE_URL + SUPABASE_ANON_KEY
  // the SPA shows a real email/password login against GoTrue; without them it falls
  // back to the dev "paste a token" mode.
  const authConfig = process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
    ? { authUrl: `${process.env.SUPABASE_URL.replace(/\/+$/, '')}/auth/v1`, anonKey: process.env.SUPABASE_ANON_KEY }
    : undefined;

  // Observability: JSON structured logs to stdout at LOG_LEVEL (default info).
  const observability = defaultObservability({ level: (process.env.LOG_LEVEL as LogLevel) ?? 'info' });

  // Per-principal rate limit — a token bucket keyed on tenant+actor. Configured
  // via RATE_LIMIT_RPS (sustained) + RATE_LIMIT_BURST (capacity); unset → disabled.
  const rateLimit = process.env.RATE_LIMIT_RPS
    ? { refillPerSec: Number(process.env.RATE_LIMIT_RPS), capacity: Number(process.env.RATE_LIMIT_BURST ?? process.env.RATE_LIMIT_RPS) }
    : undefined;

  const app = new App({ authenticator, persistence, adapters: defaultAdapterRegistry(), authConfig, observability, rateLimit });
  app.health['durableWrites'] = persistence ? 'ok (edge backend)' : 'DISABLED (no SUPABASE_FUNCTIONS_URL/SERVICE_ROLE_KEY)';
  app.health['rehydration'] = rehydration;

  observability.logger.info('starting', { port, durable: !!persistence, bootTenants: tenantIds.length, rehydration, rateLimited: !!rateLimit });

  const server = new StayServer(app, {
    reader,
    tenantIds,
    flushDebounceMs: Number(process.env.FLUSH_DEBOUNCE_MS ?? 1500),
    periodicFlushMs: Number(process.env.PERIODIC_FLUSH_MS ?? 30_000),
    // A rehydration failure must degrade (visible on /health), never crash-loop.
    onBootError: 'serve',
  });

  await server.start(port);

  // Graceful shutdown — flush pending writes before exiting so nothing is stranded.
  const shutdown = async (sig: string) => {
    console.info(`received ${sig}; draining…`);
    try { await server.stop(); } finally { process.exit(0); }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((e) => {
  console.error('failed to start:', e instanceof Error ? e.message : e);
  process.exit(1);
});
