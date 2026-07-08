// Tranche 12 — durable persistence through the Public API: snapshotWorld folds
// in-memory state into a projection-ready, tenant-scoped, balanced WorldData,
// and POST /persist flushes it through the injected backend with the same auth
// + RBAC gates as the rest of the API (invariant 3). 5 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';
import { ACCOUNTS } from '../src/billing.ts';
import { projectWorld, type WorldData } from '../src/persistence/project.ts';
import {
  EdgePersistError,
  type PersistenceBackend,
  type EdgePersistResult,
} from '../src/persistence/edge-client.ts';

const T = '2026-07-01T00:00:00Z';
const bearer = (t: string) => `Bearer ${t}`;

class FakeBackend implements PersistenceBackend {
  worlds: WorldData[] = [];
  constructor(private readonly onPersist?: (w: WorldData) => EdgePersistResult) {}
  async persist(world: WorldData): Promise<EdgePersistResult> {
    this.worlds.push(world);
    if (this.onPersist) return this.onPersist(world);
    return { ok: true, statements: projectWorld(world).length, trialBalance: 0, counts: {} };
  }
}

function makeApp(persistence?: PersistenceBackend) {
  const owner: AuthContext = { actor: 'ana', tenantId: 't-rio', role: 'owner' };
  const reader: AuthContext = { actor: 'audit', tenantId: 't-rio', role: 'read_only' };
  const other: AuthContext = { actor: 'sp', tenantId: 't-sp', role: 'owner' };
  const auth = new StaticTokenAuthenticator({ 'tok-owner': owner, 'tok-read': reader, 'tok-sp': other });
  const app = new App({
    authenticator: auth,
    persistence,
    units: [
      { id: 'u-1', tenantId: 't-rio' },
      { id: 'u-sp', tenantId: 't-sp' },
    ],
    now: () => T,
  });
  return app;
}

// Drive a full money lifecycle for one tenant through the API.
function seedLifecycle(app: App, token = 'tok-owner', tenantId = 't-rio', unitId = 'u-1', agId = 'ag-1') {
  const b = bearer(token);
  app.dispatch({ method: 'POST', path: '/agreements', bearer: b, body: { id: agId, guestId: 'g-1', unitId, kind: 'nightly', start: '2026-07-01', end: '2026-07-05', rateCents: 20000 } });
  app.dispatch({ method: 'POST', path: `/agreements/${agId}/activate`, bearer: b, body: {} });
  app.dispatch({ method: 'POST', path: '/invoices', bearer: b, body: { id: `inv-${agId}`, agreementId: agId, dueAt: '2026-07-05', lines: [{ description: '4 nights', account: ACCOUNTS.roomRevenue, amountCents: 80000 }] } });
  app.dispatch({ method: 'POST', path: '/payments', bearer: b, body: { id: `pay-${agId}`, invoiceId: `inv-${agId}`, amountCents: 80000, method: 'pix' } });
  app.dispatch({ method: 'POST', path: '/deposits', bearer: b, body: { id: `dep-${agId}`, agreementId: agId, amountCents: 50000 } });
}

test('snapshotWorld folds a lifecycle into a projection-ready, balanced world', () => {
  const app = makeApp();
  seedLifecycle(app);
  const world = app.snapshotWorld('t-rio');

  assert.equal(world.tenants.length, 1);
  assert.equal(world.agreements.length, 1);
  assert.equal(world.agreements[0]!.events.length, 2); // created + activated
  assert.equal(world.invoices.length, 1);
  assert.equal(world.payments.length, 1);
  assert.equal(world.deposits.length, 1);

  // The real kernel projection accepts it and the journal nets to zero.
  const stmts = projectWorld(world);
  let net = 0;
  for (const s of stmts) {
    if (!s.text.startsWith('insert into journal_line')) continue;
    net += (s.values[2] as number) - (s.values[3] as number);
  }
  assert.equal(net, 0);
});

test('snapshotWorld is tenant-scoped: another tenant sees none of it', () => {
  const app = makeApp();
  seedLifecycle(app); // t-rio
  seedLifecycle(app, 'tok-sp', 't-sp', 'u-sp', 'ag-sp');

  const rio = app.snapshotWorld('t-rio');
  assert.deepEqual(rio.agreements.map((a) => a.id), ['ag-1']);
  assert.ok(rio.invoices.every((i) => i.tenantId === 't-rio'));
  assert.ok(rio.journalLines.every((l) => l.agreementId === 'ag-1'));
  assert.equal(rio.holds.length, 1);
  assert.equal(rio.holds[0]!.holderId, 'ag-1');
});

test('POST /persist flushes the tenant world through the backend', async () => {
  const backend = new FakeBackend();
  const app = makeApp(backend);
  seedLifecycle(app);

  const res = await app.persist({ method: 'POST', path: '/persist', bearer: bearer('tok-owner'), body: {} });
  assert.equal(res.status, 200);
  assert.equal(backend.worlds.length, 1);
  assert.equal(backend.worlds[0]!.agreements[0]!.id, 'ag-1');
  assert.equal((res.body as EdgePersistResult).ok, true);
});

test('POST /persist enforces auth + RBAC + backend presence', async () => {
  // No backend → 501 even for an owner.
  const noBackend = makeApp();
  assert.equal((await noBackend.persist({ method: 'POST', path: '/persist', bearer: bearer('tok-owner'), body: {} })).status, 501);

  const app = makeApp(new FakeBackend());
  // No bearer → 401.
  assert.equal((await app.persist({ method: 'POST', path: '/persist', body: {} })).status, 401);
  // read_only lacks persistence.run → 403.
  assert.equal((await app.persist({ method: 'POST', path: '/persist', bearer: bearer('tok-read'), body: {} })).status, 403);
});

test('POST /persist surfaces the backend failure status (e.g. duplicate)', async () => {
  const backend = new FakeBackend(() => {
    throw new EdgePersistError(409, { error: 'duplicate', code: '23505' });
  });
  const app = makeApp(backend);
  seedLifecycle(app);
  const res = await app.persist({ method: 'POST', path: '/persist', bearer: bearer('tok-owner'), body: {} });
  assert.equal(res.status, 409);
  assert.equal((res.body as { error: string }).error, 'persist_failed');
});

test('the second flush is incremental: only newly-appended rows are sent', async () => {
  const backend = new FakeBackend();
  const app = makeApp(backend);
  seedLifecycle(app);

  const res1 = await app.persist({ method: 'POST', path: '/persist', bearer: bearer('tok-owner'), body: {} });
  assert.equal((res1.body as { incremental: boolean }).incremental, false);
  const full = backend.worlds[0]!;
  assert.equal(full.agreements[0]!.events.length, 2);
  assert.equal(full.invoices[0]!.lines.length, 1); // first flush carries the invoice line
  const linesFirst = full.journalLines.length;
  assert.ok(linesFirst > 0);

  // New activity: refund the deposit (posts journal lines, flips deposit status).
  app.dispatch({
    method: 'POST', path: '/deposits/dep-ag-1/refund', bearer: bearer('tok-owner'),
    body: { deductions: [{ reason: 'cleaning', amountCents: 8000 }] },
  });

  const res2 = await app.persist({ method: 'POST', path: '/persist', bearer: bearer('tok-owner'), body: {} });
  assert.equal((res2.body as { incremental: boolean }).incremental, true);
  const delta = backend.worlds[1]!;
  assert.equal(delta.agreements[0]!.events.length, 0);      // no new events
  assert.equal(delta.invoices[0]!.lines.length, 0);         // invoice already flushed → no re-sent lines
  assert.ok(delta.journalLines.length > 0);                 // refund entry lines are new
  assert.ok(delta.journalLines.length < linesFirst);        // only the tail, not the whole ledger
  assert.equal(delta.deposits[0]!.status, 'refunded');      // state row upserted with new status

  // The delta projects to statements with NO invoice_line insert and a deposit upsert.
  const stmts = projectWorld(delta);
  assert.ok(!stmts.some((s) => s.text.startsWith('insert into invoice_line')));
  assert.ok(stmts.some((s) => s.text.startsWith('insert into deposit') && s.text.includes('on conflict (id) do update')));
});

test('a flush with no new activity sends an empty append-delta', async () => {
  const backend = new FakeBackend();
  const app = makeApp(backend);
  seedLifecycle(app);
  await app.persist({ method: 'POST', path: '/persist', bearer: bearer('tok-owner'), body: {} });

  const res = await app.persist({ method: 'POST', path: '/persist', bearer: bearer('tok-owner'), body: {} });
  const body = res.body as { delta: { events: number; journalLines: number; actionLog: number } };
  assert.equal(body.delta.events, 0);
  assert.equal(body.delta.journalLines, 0);
  assert.equal(body.delta.actionLog, 0);
  assert.ok(backend.worlds[1]!.invoices.every((i) => i.lines.length === 0)); // no line re-sends
});

test('a failed flush does not advance the mark: the retry re-sends everything', async () => {
  let calls = 0;
  const backend = new FakeBackend(() => {
    if (calls++ === 0) throw new EdgePersistError(500, { error: 'transient' });
    return { ok: true, statements: 0, trialBalance: 0, counts: {} };
  });
  const app = makeApp(backend);
  seedLifecycle(app);

  const fail = await app.persist({ method: 'POST', path: '/persist', bearer: bearer('tok-owner'), body: {} });
  assert.equal(fail.status, 500);

  const ok = await app.persist({ method: 'POST', path: '/persist', bearer: bearer('tok-owner'), body: {} });
  assert.equal(ok.status, 200);
  // Second (successful) attempt is still a FULL send — the mark never advanced.
  assert.equal((ok.body as { incremental: boolean }).incremental, false);
  assert.equal(backend.worlds[1]!.agreements[0]!.events.length, 2);
});
