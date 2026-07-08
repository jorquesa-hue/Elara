// persist-world — the runtime write arm of the Public API, hosted inside
// Supabase so it reaches Postgres over the internal SUPABASE_DB_URL with no
// outbound egress and no connection secret living in the repo.
//
// Contract: POST a domain-level WorldData JSON body. The function projects it
// FK-ordered *server-side* (callers never submit raw SQL — invariant 3, the
// trusted boundary owns the write), asserts the journal balances app-side
// (invariant 6), then applies the whole batch in ONE transaction and forces the
// deferred balance constraint to validate with `set constraints all immediate`
// so an unbalanced or double-booked batch fails atomically (invariants 4 & 6).
//
// Auth: verify_jwt is enabled at the gateway; this body additionally requires
// role=service_role, so only the service-role backend can drive writes — no
// bypass path (invariant 2's spirit for the persistence surface).
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import postgres from 'npm:postgres@3';
import { projectWorld, type WorldData } from './projection.ts';

const DB_URL = Deno.env.get('SUPABASE_DB_URL') ?? '';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Decode a JWT payload without verifying (the gateway already verified it). */
function jwtRole(auth: string | null): string | null {
  if (!auth?.startsWith('Bearer ')) return null;
  const parts = auth.slice(7).split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(atob(pad));
    return typeof payload.role === 'string' ? payload.role : null;
  } catch {
    return null;
  }
}

function balanceOf(w: WorldData): number {
  return (w.journalLines ?? []).reduce(
    (acc, l) => acc + (Number(l.debitCents) || 0) - (Number(l.creditCents) || 0),
    0,
  );
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  // Service-role only. The gateway verified the signature; we require the role.
  if (jwtRole(req.headers.get('Authorization')) !== 'service_role') {
    return json(403, { error: 'forbidden', detail: 'service_role required' });
  }

  if (!DB_URL) return json(500, { error: 'no_db_url', detail: 'SUPABASE_DB_URL unset' });

  let world: WorldData;
  try {
    world = (await req.json()) as WorldData;
  } catch {
    return json(400, { error: 'bad_json' });
  }
  if (!world || !Array.isArray(world.journalLines) || !Array.isArray(world.agreements)) {
    return json(400, { error: 'bad_world', detail: 'missing required arrays' });
  }

  // Invariant 6, asserted additionally before the DB trigger enforces it.
  const balance = balanceOf(world);
  if (balance !== 0) {
    return json(422, { error: 'unbalanced_journal', trialBalance: balance });
  }

  const statements = projectWorld(world);

  const sql = postgres(DB_URL, { prepare: false, max: 1, idle_timeout: 5 });
  try {
    await sql.begin(async (tx) => {
      for (const s of statements) await tx.unsafe(s.text, s.values as unknown[]);
      // Force the deferred balance constraint to validate now, inside the tx,
      // so a violation surfaces here and rolls the whole batch back.
      await tx.unsafe('set constraints all immediate');
    });
  } catch (e) {
    const code = (e as { code?: string }).code;
    const detail = (e as { message?: string }).message ?? String(e);
    if (code === '23505') return json(409, { error: 'duplicate', code, detail });
    if (code === '23514' || code === '23P01' || code === '23503' || code === '23502') {
      return json(422, { error: 'constraint_violation', code, detail });
    }
    return json(500, { error: 'write_failed', code, detail });
  } finally {
    await sql.end({ timeout: 5 });
  }

  return json(200, {
    ok: true,
    statements: statements.length,
    trialBalance: 0,
    counts: {
      tenants: world.tenants?.length ?? 0,
      units: world.units?.length ?? 0,
      guests: world.guests?.length ?? 0,
      ratePlans: world.ratePlans?.length ?? 0,
      agreements: world.agreements.length,
      events: world.agreements.reduce((n, a) => n + (a.events?.length ?? 0), 0),
      holds: world.holds?.length ?? 0,
      journalLines: world.journalLines.length,
      invoices: world.invoices?.length ?? 0,
      payments: world.payments?.length ?? 0,
      deposits: world.deposits?.length ?? 0,
      actionLog: world.actionLog?.length ?? 0,
    },
  });
});
