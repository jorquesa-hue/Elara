// Tranche 45 — resilient boot. Found during the first live Fly.io deploy: a
// misconfigured/unreachable DATABASE_URL crash-looped the whole service into a
// 502, with the reason buried in machine logs. The reader is only the RELOAD
// path (durable writes flow through the edge backend regardless), so rehydration
// failure must DEGRADE — serve traffic, surface the reason on GET /health — not
// take the service down. 4 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

import { App } from '../src/api/app.ts';
import { StayServer } from '../src/api/server.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';
import type { WorldReader } from '../src/api/app.ts';

const silent = { info() {}, error() {} };

function makeApp() {
  const owner: AuthContext = { actor: 'ana', tenantId: 't1', role: 'owner' };
  const auth = new StaticTokenAuthenticator({ own: owner });
  return new App({ authenticator: auth, units: [{ id: 'u-1', tenantId: 't1' }], now: () => '2026-07-01T00:00:00Z' });
}

const throwingReader: WorldReader = {
  loadWorld: () => Promise.reject(new Error('connect ECONNREFUSED 2600:1f16::1:5432')),
};

test("onBootError:'serve' — a failed rehydration degrades instead of crashing: the server starts and /health carries the reason", async () => {
  const app = makeApp();
  const server = new StayServer(app, { reader: throwingReader, tenantIds: ['t1'], onBootError: 'serve', periodicFlushMs: 0, logger: silent });
  const s = await server.start(0); // must NOT reject
  try {
    assert.ok((s.address() as AddressInfo).port > 0, 'listening');
    const health = app.dispatch({ method: 'GET', path: '/health', bearer: 'Bearer own' });
    assert.equal(health.status, 200);
    const body = health.body as { ok: boolean; rehydration?: string };
    assert.equal(body.ok, true);
    assert.match(body.rehydration ?? '', /^degraded: .*ECONNREFUSED/);
    // The API is fully functional in degraded mode.
    const r = app.dispatch({ method: 'POST', path: '/agreements', bearer: 'Bearer own', body: { id: 'a1', unitId: 'u-1', guestId: 'g1', kind: 'nightly', start: '2026-07-02', end: '2026-07-05', rateCents: 10000 } });
    assert.equal(r.status, 201);
  } finally {
    await server.stop();
  }
});

test("default policy ('fail') keeps the historical strict behavior — start() rejects", async () => {
  const app = makeApp();
  const server = new StayServer(app, { reader: throwingReader, tenantIds: ['t1'], periodicFlushMs: 0, logger: silent });
  await assert.rejects(() => server.start(0), /ECONNREFUSED/);
});

test('a SUCCESSFUL boot stamps rehydration ok on /health', async () => {
  const seed = makeApp();
  seed.dispatch({ method: 'POST', path: '/agreements', bearer: 'Bearer own', body: { id: 'a1', unitId: 'u-1', guestId: 'g1', kind: 'nightly', start: '2026-07-02', end: '2026-07-05', rateCents: 10000 } });
  const world = seed.snapshotWorld('t1');
  const okReader: WorldReader = { loadWorld: () => Promise.resolve(world) };

  const auth = new StaticTokenAuthenticator({ own: { actor: 'ana', tenantId: 't1', role: 'owner' } });
  const app = new App({ authenticator: auth, now: () => '2026-07-01T00:00:00Z' });
  const server = new StayServer(app, { reader: okReader, tenantIds: ['t1'], onBootError: 'serve', periodicFlushMs: 0, logger: silent });
  await server.start(0);
  try {
    const body = app.dispatch({ method: 'GET', path: '/health', bearer: 'Bearer own' }).body as { rehydration?: string };
    assert.match(body.rehydration ?? '', /^ok /);
    // And the world actually rehydrated.
    assert.equal(app.dispatch({ method: 'GET', path: '/agreements/a1', bearer: 'Bearer own' }).status, 200);
  } finally {
    await server.stop();
  }
});

test('/health without any lifecycle detail still answers plain {ok:true}', () => {
  const app = makeApp();
  const body = app.dispatch({ method: 'GET', path: '/health', bearer: 'Bearer own' }).body;
  assert.deepEqual(body, { ok: true });
});
