// StayServer — the production lifecycle around the App. It closes the gap between
// "a correct in-memory kernel" and "a durable running service":
//
//   1. BOOT: on start, rehydrate every tenant's state from durable storage
//      (App.boot → reader.loadWorld → App.rehydrate), so a restarted process comes
//      back exactly where it left off (the inverse of the write projection).
//   2. FLUSH-AFTER-WRITE: after any mutating request succeeds, the tenant's new rows
//      are flushed to the durable backend on a short debounce — bounding the data-loss
//      window to at most `flushDebounceMs` of writes if the process dies.
//   3. PERIODIC SAFETY FLUSH: any tenant still dirty is flushed on an interval, so a
//      lone final write is never stranded.
//
// The App stays a synchronous in-memory router; this owns the async durability edges.

import type { Server } from 'node:http';
import { createHttpServer } from './http.ts';
import type { App, WorldReader } from './app.ts';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface StayServerOptions {
  /** Reader for cold-start rehydration. Omit to skip boot (fresh in-memory start). */
  reader?: WorldReader;
  /** Tenants to rehydrate on boot. Omit/empty → nothing to load. */
  tenantIds?: readonly string[];
  /** Debounce before flushing a tenant's writes durably (ms). Default 1500. */
  flushDebounceMs?: number;
  /** Safety-net interval to flush any still-dirty tenant (ms). Default 30000. 0 disables. */
  periodicFlushMs?: number;
  /** What to do when cold-start rehydration fails (DB unreachable, bad
   *  credentials, mid-load error): 'fail' rejects start() — the historical
   *  behavior — while 'serve' logs the error loudly, marks /health as degraded,
   *  and starts anyway (durable WRITES still flow through the edge backend; only
   *  the reload of pre-restart state is missing). Default 'fail'. */
  onBootError?: 'fail' | 'serve';
  /** Structured log sink; defaults to console. */
  logger?: { info(msg: string, meta?: unknown): void; error(msg: string, meta?: unknown): void };
}

export class StayServer {
  private readonly app: App;
  private readonly opts: Required<Omit<StayServerOptions, 'reader' | 'tenantIds' | 'logger'>> & StayServerOptions;
  private readonly log: NonNullable<StayServerOptions['logger']>;
  private server: Server | null = null;
  private readonly dirty = new Set<string>();
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private periodicTimer: ReturnType<typeof setInterval> | null = null;

  constructor(app: App, options: StayServerOptions = {}) {
    this.app = app;
    this.opts = { flushDebounceMs: 1500, periodicFlushMs: 30_000, onBootError: 'fail', ...options };
    this.log = options.logger ?? console;
  }

  /** Rehydrate (if a reader was given), then bind and listen. Resolves once listening. */
  async start(port: number): Promise<Server> {
    if (this.opts.reader && (this.opts.tenantIds?.length ?? 0) > 0) {
      const t0 = this.opts.tenantIds!;
      try {
        await this.app.boot(this.opts.reader, t0);
        this.log.info(`booted: rehydrated ${t0.length} tenant(s)`);
        this.app.health['rehydration'] = `ok (${t0.length} tenant(s))`;
      } catch (e) {
        if ((this.opts.onBootError ?? 'fail') === 'fail') throw e;
        const reason = e instanceof Error ? e.message : String(e);
        // Serve rather than crash-loop: the operator gets a working portal and a
        // visible diagnosis instead of a 502. Durable writes still flush through
        // the edge backend; only pre-restart state is missing until the reader
        // (DATABASE_URL) is fixed and the process restarts.
        this.log.error('BOOT DEGRADED: cold-start rehydration failed; serving without it', reason);
        this.app.health['rehydration'] = `degraded: ${reason}`;
      }
    }

    this.server = createHttpServer(this.app, {
      onResponse: ({ method, path, status, bearer }) => {
        // A successful mutation (not /persist — that already flushed) makes the
        // caller's tenant dirty; flush it durably on a debounce.
        if (!MUTATING.has(method) || status >= 300 || path === '/persist') return;
        const ctx = this.app.identify(bearer);
        if (ctx) this.markDirty(ctx.tenantId);
      },
    });

    if (this.opts.periodicFlushMs > 0) {
      this.periodicTimer = setInterval(() => void this.flushAllDirty(), this.opts.periodicFlushMs);
    }

    await new Promise<void>((resolve) => this.server!.listen(port, resolve));
    this.log.info(`listening on :${port}`);
    return this.server;
  }

  private markDirty(tenantId: string): void {
    this.dirty.add(tenantId);
    const existing = this.debounceTimers.get(tenantId);
    if (existing) clearTimeout(existing);
    this.debounceTimers.set(
      tenantId,
      setTimeout(() => void this.flushTenant(tenantId), this.opts.flushDebounceMs),
    );
  }

  private async flushTenant(tenantId: string): Promise<void> {
    this.debounceTimers.delete(tenantId);
    this.dirty.delete(tenantId);
    try {
      const result = await this.app.flushWorld(tenantId);
      this.log.info(`flushed ${tenantId}`, result);
    } catch (e) {
      // Re-dirty so the periodic sweep (or the next write) retries — the flush mark
      // only advances on success, so nothing is lost.
      this.dirty.add(tenantId);
      this.log.error(`flush failed for ${tenantId}`, e instanceof Error ? e.message : e);
    }
  }

  private async flushAllDirty(): Promise<void> {
    for (const tenantId of [...this.dirty]) await this.flushTenant(tenantId);
  }

  /** Flush everything pending, stop timers, and close the socket (graceful shutdown). */
  async stop(): Promise<void> {
    for (const t of this.debounceTimers.values()) clearTimeout(t);
    this.debounceTimers.clear();
    if (this.periodicTimer) clearInterval(this.periodicTimer);
    await this.flushAllDirty();
    if (this.server) await new Promise<void>((resolve, reject) => this.server!.close((e) => (e ? reject(e) : resolve())));
    this.server = null;
  }
}
