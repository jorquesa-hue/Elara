// Tranche 44 — regressions for the end-to-end flow audit. Seven defects found by
// driving the property-ops / finance / resident / platform / agent flows:
//  A. a failed unit transfer left partially-applied state (event persisted, hold
//     dropped, agreement wedged, old unit double-bookable)
//  B. non-ISO date strings bypassed the lexicographic calendar overlap check
//  C. POST /bills with a poId was non-atomic (bill booked + GL posted even when
//     the PO refused the billing)
//  D. accounts-payable journal lines (no agreementId) were invisible to every
//     tenant-scoped read — trial balance misstated cash and AP money history was
//     lost on snapshot/rehydrate
//  E. concurrent flushes double-sent the append-only streams
//  F. an oversized request got ECONNRESET instead of the documented 413
//  G. pending policy escalations were silently lost on restart
// 13 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';

import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';
import { createHttpServer } from '../src/api/http.ts';
import type { PersistenceBackend } from '../src/persistence/edge-client.ts';
import type { WorldData } from '../src/persistence/project.ts';

const T = '2026-07-01T00:00:00Z';
const bearer = (t: string) => `Bearer ${t}`;
const D = (app: App, method: string, path: string, token: string, body?: Record<string, unknown>) =>
  app.dispatch({ method, path, bearer: bearer(token), body });

function makeApp(persistence?: PersistenceBackend) {
  const mgr: AuthContext = { actor: 'mgr', tenantId: 't1', role: 'manager' };
  // A second approver: SoD forbids the initiator ('mgr') approving their own escalation.
  const boss: AuthContext = { actor: 'boss', tenantId: 't1', role: 'manager' };
  const auth = new StaticTokenAuthenticator({ mgr, boss });
  return new App({
    authenticator: auth,
    units: [{ id: 'u-1', tenantId: 't1' }, { id: 'u-2', tenantId: 't1' }, { id: 'u-3', tenantId: 't1' }],
    now: () => T,
    ...(persistence ? { persistence } : {}),
  });
}

const book = (app: App, id: string, unitId: string, start = '2026-07-02', end = '2026-07-20') =>
  D(app, 'POST', '/agreements', 'mgr', { id, unitId, guestId: 'g1', kind: 'monthly', start, end, rateCents: 100000 });

// ---- A. transfer atomicity --------------------------------------------------

test('a transfer blocked by double inventory leaves the agreement fully unchanged', () => {
  const app = makeApp();
  book(app, 'ag-a', 'u-1');
  D(app, 'POST', '/agreements/ag-a/activate', 'mgr', {});
  book(app, 'ag-b', 'u-2'); // occupies the transfer target for the same window
  const before = D(app, 'GET', '/agreements/ag-a', 'mgr').body as { unitId: string };

  const r = D(app, 'POST', '/agreements/ag-a/transfer', 'mgr', { toUnitId: 'u-2' });
  assert.equal(r.status, 409); // double inventory on the target

  // NOTHING mutated: same unit, no transferred event, the OLD hold still guards u-1.
  const after = D(app, 'GET', '/agreements/ag-a', 'mgr').body as { unitId: string };
  assert.equal(after.unitId, before.unitId);
  const history = (D(app, 'GET', '/agreements/ag-a', 'mgr').body as { history: Array<{ type: string }> }).history;
  assert.ok(!history.some((e) => e.type === 'transferred'), 'no transferred event leaked');
  assert.equal(book(app, 'ag-squat', 'u-1').status, 409, 'old unit still protected by the original hold');

  // And the agreement is NOT wedged: a transfer to a free unit still works.
  assert.equal(D(app, 'POST', '/agreements/ag-a/transfer', 'mgr', { toUnitId: 'u-3' }).status, 200);
});

test('transferring to the unit the agreement already occupies is rejected cleanly', () => {
  const app = makeApp();
  book(app, 'ag-a', 'u-1');
  D(app, 'POST', '/agreements/ag-a/activate', 'mgr', {});
  assert.equal(D(app, 'POST', '/agreements/ag-a/transfer', 'mgr', { toUnitId: 'u-1' }).status, 400);
});

test('a transfer refused by the AGREEMENT (draft status) rolls the probe hold back', () => {
  const app = makeApp();
  book(app, 'ag-a', 'u-1'); // draft — transfer must refuse
  assert.equal(D(app, 'POST', '/agreements/ag-a/transfer', 'mgr', { toUnitId: 'u-3' }).status, 409);
  // The probe hold on u-3 was released — the unit is still bookable.
  assert.equal(book(app, 'ag-c', 'u-3').status, 201);
});

// ---- B. calendar date validation -------------------------------------------

test('non-ISO date strings are rejected instead of bypassing the overlap check', () => {
  const app = makeApp();
  for (const [start, end] of [['07/15/2026', '2026-12-31'], ['banana', '2026-12-31'], ['2026-07-02', 'later'], ['2026-02-30', '2026-12-31']]) {
    const r = book(app, `ag-bad-${start}`, 'u-1', start!, end!);
    assert.ok(r.status === 400 || r.status === 409, `'${start}'..'${end}' must be rejected, got ${r.status}`);
    assert.ok(r.status < 500);
  }
  // No phantom hold was left behind — a legitimate booking still succeeds…
  assert.equal(book(app, 'ag-good', 'u-1').status, 201);
  // …and the guarantee still holds after it.
  assert.equal(book(app, 'ag-overlap', 'u-1').status, 409);
});

// ---- C. bill + purchase order atomicity -------------------------------------

test('a bill whose PO refuses the billing is never booked (no GL entry, not payable)', () => {
  const app = makeApp();
  D(app, 'POST', '/parties', 'mgr', { id: 'p-v', kind: 'organization', displayName: 'Vendor' });
  D(app, 'POST', '/purchase-orders', 'mgr', { id: 'po1', vendorId: 'p-v', currency: 'BRL', lines: [{ description: 'paint', account: 'expenses:maintenance', amountCents: 100000 }] });
  D(app, 'POST', '/purchase-orders/po1/approve', 'mgr', {});

  const tbBefore = D(app, 'GET', '/ledger/trial-balance', 'mgr').body as { balances: Record<string, number> };
  const r = D(app, 'POST', '/bills', 'mgr', { id: 'b-over', payeeId: 'p-v', dueAt: '2026-07-20', poId: 'po1', lines: [{ description: 'paint', account: 'expenses:maintenance', amountCents: 150000 }] });
  assert.equal(r.status, 409); // exceeds the PO total

  // Atomic: the bill does not exist and the GL is untouched.
  const bills = (D(app, 'GET', '/bills', 'mgr').body as { bills: Array<{ id: string }> }).bills;
  assert.ok(!bills.some((b) => b.id === 'b-over'));
  assert.deepEqual(D(app, 'GET', '/ledger/trial-balance', 'mgr').body, tbBefore);

  // A bill the PO CAN absorb still records + auto-closes as before.
  assert.equal(D(app, 'POST', '/bills', 'mgr', { id: 'b-ok', payeeId: 'p-v', dueAt: '2026-07-20', poId: 'po1', lines: [{ description: 'paint', account: 'expenses:maintenance', amountCents: 100000 }] }).status, 201);
  const po = D(app, 'GET', '/purchase-orders/po1', 'mgr').body as { status: string; billedCents: number };
  assert.equal(po.status, 'closed');
  assert.equal(po.billedCents, 100000);
});

// ---- D. AP journal lines are tenant-scoped ----------------------------------

function seedApWorld(app: App) {
  D(app, 'POST', '/parties', 'mgr', { id: 'p-v', kind: 'organization', displayName: 'Vendor' });
  book(app, 'ag-a', 'u-1');
  D(app, 'POST', '/bills', 'mgr', { id: 'b1', payeeId: 'p-v', dueAt: '2026-07-20', lines: [{ description: 'repair', account: 'expenses:maintenance', amountCents: 40000 }] });
  D(app, 'POST', '/bills/b1/pay', 'mgr', { id: 'pay1', amountCents: 40000, method: 'transfer' });
}

test('the tenant trial balance includes accounts-payable activity (cash reflects the payout)', () => {
  const app = makeApp();
  seedApWorld(app);
  const tb = D(app, 'GET', '/ledger/trial-balance', 'mgr').body as { balances: Record<string, number>; balanced: boolean };
  assert.equal(tb.balances['expenses:maintenance'], 40000);
  assert.equal(tb.balances['assets:cash'], -40000); // the payout is VISIBLE, not silently omitted
  assert.equal(tb.balances['liabilities:accounts_payable'] ?? 0, 0); // issued then settled
  assert.equal(tb.balanced, true);
});

test('AP journal lines survive the snapshot → rehydrate round trip', () => {
  const app = makeApp();
  seedApWorld(app);
  const world = app.snapshotWorld('t1');
  const apLines = world.journalLines.filter((l) => l.entryId.startsWith('bill-') || l.entryId.startsWith('appay-'));
  assert.equal(apLines.length, 4, 'both AP entries (2 lines each) are in the snapshot');
  assert.ok(apLines.every((l) => (l as { tenantId?: string }).tenantId === 't1'));

  const auth = new StaticTokenAuthenticator({ mgr: { actor: 'mgr', tenantId: 't1', role: 'manager' } });
  const fresh = new App({ authenticator: auth, now: () => T });
  fresh.rehydrate(world);
  assert.deepEqual(
    D(fresh, 'GET', '/ledger/trial-balance', 'mgr').body,
    D(app, 'GET', '/ledger/trial-balance', 'mgr').body,
  );
});

test('the incremental flush mark counts AP lines (no re-send, no gap)', async () => {
  const worlds: WorldData[] = [];
  const backend: PersistenceBackend = { persist: async (w) => { worlds.push(w); return { ok: true, statements: 0, trialBalance: 0 } as never; } };
  const app = makeApp(backend);
  seedApWorld(app);
  await app.flushWorld('t1');
  const first = worlds[0]!.journalLines.length;
  assert.ok(worlds[0]!.journalLines.some((l) => l.entryId === 'bill-b1'));
  await app.flushWorld('t1'); // nothing new
  assert.equal(worlds[1]!.journalLines.length, 0);
  D(app, 'POST', '/bills', 'mgr', { id: 'b2', payeeId: 'p-v', dueAt: '2026-07-25', lines: [{ description: 'parts', account: 'expenses:maintenance', amountCents: 5000 }] });
  await app.flushWorld('t1');
  assert.equal(worlds[2]!.journalLines.length, 2); // only the new bill's entry
  assert.ok(first >= 4);
});

// ---- E. concurrent flushes serialize ----------------------------------------

test('two overlapping flushes never double-send the append-only streams', async () => {
  const worlds: WorldData[] = [];
  const backend: PersistenceBackend = {
    persist: async (w) => {
      await new Promise((r) => setTimeout(r, 25)); // hold the first flush open
      worlds.push(w);
      return { ok: true, statements: 0, trialBalance: 0 } as never;
    },
  };
  const app = makeApp(backend);
  book(app, 'ag-a', 'u-1');
  D(app, 'POST', '/agreements/ag-a/activate', 'mgr', {});

  await Promise.all([app.flushWorld('t1'), app.flushWorld('t1')]); // the race
  const totalEvents = worlds.reduce((n, w) => n + w.agreements.reduce((m, a) => m + a.events.length, 0), 0);
  const actualEvents = (app.snapshotWorld('t1').agreements[0]?.events ?? []).length;
  assert.equal(totalEvents, actualEvents, 'each event flushed exactly once across the racing flushes');
});

// ---- F. oversized body gets a real 413 --------------------------------------

test('a >1MiB request receives an HTTP 413 response, not a reset socket', async () => {
  const app = makeApp();
  const server = createHttpServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { port, method: 'POST', path: '/agreements', headers: { authorization: 'Bearer mgr', 'content-type': 'application/json' } },
        (res) => { res.resume(); resolve(res.statusCode ?? 0); },
      );
      req.on('error', reject); // pre-fix this fired ECONNRESET before any response
      const chunk = Buffer.alloc(256 * 1024, 0x61);
      for (let i = 0; i < 8; i++) req.write(chunk); // 2 MiB
      req.end();
    });
    assert.equal(status, 413);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---- G. escalations survive a restart ----------------------------------------

function escalate(app: App): string {
  D(app, 'POST', '/parties', 'mgr', { id: 'p-v', kind: 'organization', displayName: 'Vendor' });
  D(app, 'POST', '/bills', 'mgr', { id: 'b-big', payeeId: 'p-v', dueAt: '2026-07-20', lines: [{ description: 'roof', account: 'expenses:maintenance', amountCents: 600000 }] });
  const r = D(app, 'POST', '/bills/b-big/pay', 'mgr', { id: 'pay-big', amountCents: 600000, method: 'transfer' });
  assert.equal(r.status, 202);
  return (r.body as { exceptionId: string }).exceptionId;
}

test('a pending escalation is in the snapshot and still pending after rehydrate', () => {
  const app = makeApp();
  const excId = escalate(app);
  const world = app.snapshotWorld('t1');
  assert.ok((world.exceptions ?? []).some((x) => x.id === excId && x.status === 'pending'));

  const auth = new StaticTokenAuthenticator({ mgr: { actor: 'mgr', tenantId: 't1', role: 'manager' } });
  const fresh = new App({ authenticator: auth, now: () => T });
  fresh.rehydrate(world);
  const pending = (D(fresh, 'GET', '/exceptions', 'mgr').body as { pending: Array<{ id: string }> }).pending;
  assert.ok(pending.some((x) => x.id === excId), 'the parked decision survived the restart');
});

test('approving a REHYDRATED escalation records the decision with executed:false', () => {
  const app = makeApp();
  const excId = escalate(app);
  const auth = new StaticTokenAuthenticator({ mgr: { actor: 'mgr', tenantId: 't1', role: 'manager' }, boss: { actor: 'boss', tenantId: 't1', role: 'manager' } });
  const fresh = new App({ authenticator: auth, now: () => T });
  fresh.rehydrate(app.snapshotWorld('t1'));

  const r = D(fresh, 'POST', '/exceptions/' + excId + '/approve', 'boss', { note: 'ok' });
  assert.equal(r.status, 200);
  const body = r.body as { status: string; executed: boolean };
  assert.equal(body.status, 'approved');
  assert.equal(body.executed, false); // the thunk did not survive the restart — the action must be re-initiated
  const bill = (D(fresh, 'GET', '/bills', 'mgr').body as { bills: Array<{ id: string; status: string }> }).bills.find((b) => b.id === 'b-big');
  assert.equal(bill!.status, 'open'); // crucially NOT silently marked paid
});

test('approving a LIVE escalation still executes the deferred payment (executed:true)', () => {
  const app = makeApp();
  const excId = escalate(app);
  const r = D(app, 'POST', '/exceptions/' + excId + '/approve', 'boss', {});
  assert.equal((r.body as { executed: boolean }).executed, true);
  const bill = (D(app, 'GET', '/bills', 'mgr').body as { bills: Array<{ id: string; status: string }> }).bills.find((b) => b.id === 'b-big');
  assert.equal(bill!.status, 'paid');
});

test('a rehydrated queue never reuses a loaded exception id for new escalations', () => {
  const app = makeApp();
  const excId = escalate(app);
  const auth = new StaticTokenAuthenticator({ mgr: { actor: 'mgr', tenantId: 't1', role: 'manager' } });
  const fresh = new App({ authenticator: auth, now: () => T });
  fresh.rehydrate(app.snapshotWorld('t1'));
  // Park a NEW escalation on the fresh app; its id must not collide.
  D(fresh, 'POST', '/bills', 'mgr', { id: 'b-big2', payeeId: 'p-v', dueAt: '2026-07-21', lines: [{ description: 'wall', account: 'expenses:maintenance', amountCents: 700000 }] });
  const r = D(fresh, 'POST', '/bills/b-big2/pay', 'mgr', { id: 'pay-big2', amountCents: 700000, method: 'transfer' });
  assert.equal(r.status, 202);
  assert.notEqual((r.body as { exceptionId: string }).exceptionId, excId);
});
