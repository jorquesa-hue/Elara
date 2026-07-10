// Tranche 38 — the deployment durability lifecycle: boot (cold-start rehydrate),
// flush-after-write, and the StayServer that wires both around a running HTTP
// process. Together they close the gap between a correct in-memory kernel and a
// durable service that survives a restart. 8 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/api/app.ts';
import { StayServer } from '../src/api/server.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';
import type { PersistenceBackend } from '../src/persistence/edge-client.ts';
import type { WorldData } from '../src/persistence/project.ts';

const T = '2026-07-01T00:00:00Z';
const bearer = (t: string) => `Bearer ${t}`;
const D = (app: App, method: string, path: string, token: string, body?: Record<string, unknown>) =>
  app.dispatch({ method, path, bearer: bearer(token), body });

/** A backend that records every world it was asked to persist. */
class RecordingBackend implements PersistenceBackend {
  readonly worlds: WorldData[] = [];
  async persist(world: WorldData) {
    this.worlds.push(world);
    return { ok: true, statements: 0, trialBalance: 0, counts: {} } as never;
  }
}

function tokens() {
  const owner: AuthContext = { actor: 'ana', tenantId: 't1', role: 'owner' };
  return new StaticTokenAuthenticator({ own: owner });
}

function bookOne(app: App, id = 'ag-1') {
  D(app, 'POST', '/agreements', 'own', { id, guestId: 'g-1', unitId: 'u-1', kind: 'nightly', start: '2026-07-01', end: '2026-07-10', rateCents: 20000 });
}

// ---- flushWorld (internal, incremental) ----------------------------------

test('flushWorld sends the tenant world to the backend', async () => {
  const backend = new RecordingBackend();
  const app = new App({ authenticator: tokens(), units: [{ id: 'u-1', tenantId: 't1' }], persistence: backend, now: () => T });
  bookOne(app);
  await app.flushWorld('t1');
  assert.equal(backend.worlds.length, 1);
  assert.equal(backend.worlds[0]!.agreements.length, 1);
});

test('a second flush is incremental — no re-send of already-flushed events', async () => {
  const backend = new RecordingBackend();
  const app = new App({ authenticator: tokens(), units: [{ id: 'u-1', tenantId: 't1' }], persistence: backend, now: () => T });
  bookOne(app);
  await app.flushWorld('t1');
  await app.flushWorld('t1'); // nothing new
  const secondEvents = backend.worlds[1]!.agreements.reduce((n, a) => n + a.events.length, 0);
  assert.equal(secondEvents, 0);
});

test('flushWorld without a backend throws (the caller decides how loud to be)', async () => {
  const app = new App({ authenticator: tokens(), now: () => T });
  await assert.rejects(() => app.flushWorld('t1'));
});

// ---- boot (cold-start rehydrate) -----------------------------------------

test('boot rehydrates a tenant from the reader, then flushes only NEW rows', async () => {
  // App A builds a world and snapshots it — that snapshot is what durable storage holds.
  const backendA = new RecordingBackend();
  const a = new App({ authenticator: tokens(), units: [{ id: 'u-1', tenantId: 't1' }], persistence: backendA, now: () => T });
  bookOne(a);
  const stored = a.snapshotWorld('t1');

  // App B boots from a reader returning that world, then a fresh write flushes incrementally.
  const backendB = new RecordingBackend();
  const b = new App({ authenticator: tokens(), persistence: backendB, now: () => T });
  await b.boot({ loadWorld: async () => stored }, ['t1']);
  // The rehydrated agreement is present…
  assert.equal((b.dispatch({ method: 'GET', path: '/agreements/ag-1', bearer: bearer('own') })).status, 200);
  // …and because boot set the flush mark, a flush right now sends nothing new.
  await b.flushWorld('t1');
  assert.equal(backendB.worlds[0]!.agreements.reduce((n, ag) => n + ag.events.length, 0), 0);
});

// ---- StayServer (boot + auto-flush over HTTP) ----------------------------

async function httpJson(port: number, method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { authorization: bearer(token), 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('StayServer boots from the reader before serving', async () => {
  const seed = new App({ authenticator: tokens(), units: [{ id: 'u-1', tenantId: 't1' }], now: () => T });
  bookOne(seed);
  const stored = seed.snapshotWorld('t1');

  const app = new App({ authenticator: tokens(), persistence: new RecordingBackend(), now: () => T });
  const server = new StayServer(app, { reader: { loadWorld: async () => stored }, tenantIds: ['t1'], periodicFlushMs: 0, logger: silent() });
  await server.start(0);
  const port = (server as unknown as { server: { address(): { port: number } } }).server.address().port;
  try {
    const r = await httpJson(port, 'GET', '/agreements/ag-1', 'own');
    assert.equal(r.status, 200); // the booted agreement is served
  } finally {
    await server.stop();
  }
});

test('StayServer flushes a tenant durably after a mutating write (debounced)', async () => {
  const backend = new RecordingBackend();
  const app = new App({ authenticator: tokens(), units: [{ id: 'u-1', tenantId: 't1' }], persistence: backend, now: () => T });
  const server = new StayServer(app, { flushDebounceMs: 20, periodicFlushMs: 0, logger: silent() });
  await server.start(0);
  const port = (server as unknown as { server: { address(): { port: number } } }).server.address().port;
  try {
    const r = await httpJson(port, 'POST', '/agreements', 'own', { id: 'ag-1', guestId: 'g-1', unitId: 'u-1', kind: 'nightly', start: '2026-07-01', end: '2026-07-10', rateCents: 20000 });
    assert.equal(r.status, 201);
    await sleep(80); // past the debounce
    assert.ok(backend.worlds.length >= 1, 'a flush happened after the write');
    assert.equal(backend.worlds[backend.worlds.length - 1]!.agreements.length, 1);
  } finally {
    await server.stop();
  }
});

test('StayServer does NOT flush after a read (GET)', async () => {
  const backend = new RecordingBackend();
  const app = new App({ authenticator: tokens(), units: [{ id: 'u-1', tenantId: 't1' }], persistence: backend, now: () => T });
  const server = new StayServer(app, { flushDebounceMs: 20, periodicFlushMs: 0, logger: silent() });
  await server.start(0);
  const port = (server as unknown as { server: { address(): { port: number } } }).server.address().port;
  try {
    await httpJson(port, 'GET', '/health', 'own');
    await sleep(60);
    assert.equal(backend.worlds.length, 0);
  } finally {
    await server.stop();
  }
});

test('stop() performs a final flush of pending writes (graceful shutdown)', async () => {
  const backend = new RecordingBackend();
  const app = new App({ authenticator: tokens(), units: [{ id: 'u-1', tenantId: 't1' }], persistence: backend, now: () => T });
  // A long debounce so the write is still pending when we stop.
  const server = new StayServer(app, { flushDebounceMs: 10_000, periodicFlushMs: 0, logger: silent() });
  await server.start(0);
  const port = (server as unknown as { server: { address(): { port: number } } }).server.address().port;
  await httpJson(port, 'POST', '/agreements', 'own', { id: 'ag-1', guestId: 'g-1', unitId: 'u-1', kind: 'nightly', start: '2026-07-01', end: '2026-07-10', rateCents: 20000 });
  await server.stop(); // flushes on the way out
  assert.ok(backend.worlds.length >= 1);
});

function silent() {
  return { info: () => {}, error: () => {} };
}
