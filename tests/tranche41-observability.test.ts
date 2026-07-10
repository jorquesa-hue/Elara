// Tranche 41 — observability + rate limiting. The App emits a metrics sample and
// a structured log line per request, records policy decisions, exposes a scrapable
// GET /metrics (Prometheus text), and bounds abuse from one principal with a
// token-bucket rate limiter. Zero runtime deps. 14 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';
import { Logger, Metrics } from '../src/observability.ts';
import { RateLimiter } from '../src/ratelimit.ts';
import type { LogRecord, Observability } from '../src/observability.ts';

const bearer = (t: string) => `Bearer ${t}`;
const D = (app: App, method: string, path: string, token?: string, body?: Record<string, unknown>) =>
  app.dispatch({ method, path, bearer: token ? bearer(token) : undefined, body });

function makeApp(opts: { observability?: Partial<Observability>; rateLimit?: RateLimiter | { capacity: number; refillPerSec: number } } = {}) {
  const mgr: AuthContext = { actor: 'mgr', tenantId: 't1', role: 'manager' };
  const ro: AuthContext = { actor: 'aud', tenantId: 't1', role: 'read_only' };
  const auth = new StaticTokenAuthenticator({ mgr, ro });
  return new App({ authenticator: auth, units: [{ id: 'u-1', tenantId: 't1' }], now: () => '2026-07-01T00:00:00Z', ...opts });
}

// ---- Logger ---------------------------------------------------------------

test('Logger emits a structured record with base + call fields to the sink', () => {
  const records: LogRecord[] = [];
  const log = new Logger({ sink: (r) => records.push(r), clock: () => 'T', base: { svc: 'api' } });
  log.info('hello', { n: 1 });
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], { at: 'T', level: 'info', msg: 'hello', svc: 'api', n: 1 });
});

test('Logger redacts sensitive field names', () => {
  const records: LogRecord[] = [];
  new Logger({ sink: (r) => records.push(r) }).info('auth', { authorization: 'Bearer secret', token: 'abc', ok: true });
  assert.equal(records[0]!.authorization, '[redacted]');
  assert.equal(records[0]!.token, '[redacted]');
  assert.equal(records[0]!.ok, true);
});

test('Logger honors the minimum level', () => {
  const records: LogRecord[] = [];
  const log = new Logger({ sink: (r) => records.push(r), level: 'warn' });
  log.info('skip');
  log.warn('kept');
  assert.deepEqual(records.map((r) => r.msg), ['kept']);
});

test('a throwing sink never propagates out of the logger', () => {
  const log = new Logger({ sink: () => { throw new Error('sink down'); } });
  assert.doesNotThrow(() => log.error('boom'));
});

// ---- Metrics --------------------------------------------------------------

test('Metrics counters aggregate per label set', () => {
  const m = new Metrics();
  m.increment('req', { route: '/a' });
  m.increment('req', { route: '/a' });
  m.increment('req', { route: '/b' });
  const snap = m.snapshot();
  const a = snap.counters.find((c) => c.labels.route === '/a')!;
  const b = snap.counters.find((c) => c.labels.route === '/b')!;
  assert.equal(a.value, 2);
  assert.equal(b.value, 1);
});

test('Metrics histogram observes count/sum/buckets and renders Prometheus text', () => {
  const m = new Metrics({ buckets: [10, 100] });
  m.observe('lat', 5, { route: '/a' });
  m.observe('lat', 50, { route: '/a' });
  const h = m.snapshot().histograms[0]!;
  assert.equal(h.count, 2);
  assert.equal(h.sum, 55);
  const prom = m.renderProm();
  // Labels render in sorted key order (le before route).
  assert.match(prom, /# TYPE lat histogram/);
  assert.match(prom, /lat_bucket\{le="10",route="\/a"\} 1/);
  assert.match(prom, /lat_bucket\{le="100",route="\/a"\} 2/);
  assert.match(prom, /lat_bucket\{le="\+Inf",route="\/a"\} 2/);
  assert.match(prom, /lat_count\{route="\/a"\} 2/);
});

// ---- RateLimiter ----------------------------------------------------------

test('RateLimiter allows up to capacity then refuses with a retry hint', () => {
  let now = 0;
  const rl = new RateLimiter({ capacity: 2, refillPerSec: 1, nowMs: () => now });
  assert.equal(rl.take('k').allowed, true);
  assert.equal(rl.take('k').allowed, true);
  const refused = rl.take('k');
  assert.equal(refused.allowed, false);
  assert.equal(refused.retryAfterSec, 1);
  assert.equal(refused.limit, 2);
});

test('RateLimiter refills continuously over time', () => {
  let now = 0;
  const rl = new RateLimiter({ capacity: 1, refillPerSec: 1, nowMs: () => now });
  assert.equal(rl.take('k').allowed, true);
  assert.equal(rl.take('k').allowed, false);
  now = 1000; // one second → one token back
  assert.equal(rl.take('k').allowed, true);
});

test('RateLimiter buckets are independent per key', () => {
  let now = 0;
  const rl = new RateLimiter({ capacity: 1, refillPerSec: 1, nowMs: () => now });
  assert.equal(rl.take('a').allowed, true);
  assert.equal(rl.take('b').allowed, true); // b's bucket is untouched by a
  assert.equal(rl.take('a').allowed, false);
});

// ---- App integration ------------------------------------------------------

test('a request increments http_requests_total with the route pattern (not the raw path)', () => {
  const metrics = new Metrics();
  const app = makeApp({ observability: { metrics } });
  D(app, 'GET', '/agreements/xyz/billing', 'mgr');
  const c = metrics.snapshot().counters.find((c) => c.name === 'http_requests_total');
  assert.ok(c, 'a request counter exists');
  // The label is the pattern with :id, never the concrete id — keeps cardinality low.
  assert.ok(metrics.snapshot().counters.some((c) => c.labels.route === '/agreements/:id/billing'));
  assert.ok(!metrics.snapshot().counters.some((c) => (c.labels.route ?? '').includes('xyz')));
});

test('each request logs one structured line with method/route/status/tenant', () => {
  const records: LogRecord[] = [];
  const app = makeApp({ observability: { logger: new Logger({ sink: (r) => records.push(r) }) } });
  D(app, 'GET', '/me', 'mgr');
  const line = records.find((r) => r.msg === 'request');
  assert.ok(line);
  assert.equal(line!.route, '/me');
  assert.equal(line!.status, 200);
  assert.equal(line!.tenant, 't1');
});

test('a gated policy decision is counted by action + outcome', () => {
  const metrics = new Metrics();
  const app = makeApp({ observability: { metrics } });
  const r = D(app, 'POST', '/agreements', 'mgr', { id: 'a1', unitId: 'u-1', guestId: 'g1', kind: 'nightly', start: '2026-07-02', end: '2026-07-05', rateCents: 20000 });
  assert.equal(r.status, 201);
  const dec = metrics.snapshot().counters.find((c) => c.name === 'policy_decisions_total');
  assert.ok(dec);
  assert.equal(dec!.labels.outcome, 'executed');
  assert.equal(dec!.labels.action, 'agreement.create');
});

test('GET /metrics requires metrics.scrape and returns Prometheus text', () => {
  const app = makeApp();
  D(app, 'GET', '/me', 'mgr'); // generate a sample
  assert.equal(D(app, 'GET', '/metrics', 'ro').status, 403); // read_only lacks metrics.scrape
  const ok = D(app, 'GET', '/metrics', 'mgr');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers?.['content-type'], 'text/plain; version=0.0.4; charset=utf-8');
  assert.match(ok.body as string, /http_requests_total/);
});

test('the rate limiter returns 429 with Retry-After once a principal exhausts its bucket', () => {
  let now = 0;
  const app = makeApp({ rateLimit: new RateLimiter({ capacity: 2, refillPerSec: 1, nowMs: () => now }) });
  assert.equal(D(app, 'GET', '/me', 'mgr').status, 200);
  assert.equal(D(app, 'GET', '/me', 'mgr').status, 200);
  const limited = D(app, 'GET', '/me', 'mgr');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers?.['retry-after'], '1');
  // A different principal has its own bucket and is unaffected.
  assert.equal(D(app, 'GET', '/me', 'ro').status, 200);
});
