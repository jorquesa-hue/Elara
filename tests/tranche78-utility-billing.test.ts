// Tranche 78 — Phase 6B: utility billing / RUBS. A master utility bill for a
// property is recovered from residents by an allocation ratio (equal /
// occupancy / area / bedrooms); the allocation sums exactly to the master total
// and the bill step raises a resident invoice per share through the gated
// invoice.issue path (no bypass), idempotent. RBAC-only, durable. 12 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';
import { projectWorld } from '../src/persistence/project.ts';
import { allocateUtility } from '../src/utility-billing.ts';

const NOW = '2026-07-13T00:00:00Z';
const own: AuthContext = { actor: 'own', tenantId: 'mf', role: 'owner' };
const acct: AuthContext = { actor: 'acc', tenantId: 'mf', role: 'accountant' };
const bot: AuthContext = { actor: 'bot', tenantId: 'mf', role: 'agent' };
const ro: AuthContext = { actor: 'r', tenantId: 'mf', role: 'read_only' };

const D = (app: App, method: string, path: string, body?: Record<string, unknown>, token = 'own') =>
  app.dispatch({ method, path, bearer: `Bearer ${token}`, body: body ?? {} });

function mkApp() {
  const app = new App({ authenticator: new StaticTokenAuthenticator({ own, acc: acct, bot, r: ro }), units: [], now: () => NOW });
  D(app, 'PUT', '/config', { displayName: 'Greyline', country: 'US' });
  D(app, 'POST', '/properties', { id: 'prop-1', code: 'NG', name: 'Northgate' });
  // Two active leases in the property.
  for (const n of ['1', '2']) {
    D(app, 'POST', '/units', { id: 'u-' + n, code: 'A-' + n, label: 'Apt 10' + n, propertyId: 'prop-1' });
    D(app, 'POST', '/agreements', { id: 'ag-' + n, guestId: 'Resident ' + n, unitId: 'u-' + n, kind: 'lease', start: '2026-01-01', end: '2027-01-01', rateCents: 300000 });
    D(app, 'POST', '/agreements/ag-' + n + '/activate', {});
  }
  return app;
}
function create(app: App, over: Record<string, unknown> = {}, token = 'own') {
  return D(app, 'POST', '/utility-bills', {
    id: 'util-1', propertyId: 'prop-1', utility: 'water', method: 'equal',
    periodStart: '2026-06-01', periodEnd: '2026-07-01', totalCents: 90001, ...over,
  }, token);
}

// --- pure allocation ---------------------------------------------------------

test('allocateUtility splits equally and sums to the exact total', () => {
  const parts = [{ agreementId: 'a', unitId: 'u1' }, { agreementId: 'b', unitId: 'u2' }, { agreementId: 'c', unitId: 'u3' }];
  const shares = allocateUtility(100, 'equal', parts);
  assert.equal(shares.reduce((n, s) => n + s.shareCents, 0), 100); // 33 + 33 + 34
  assert.equal(shares[2]!.shareCents, 34); // remainder on the last
});

test('allocateUtility weights by occupancy and by area', () => {
  const occ = allocateUtility(300, 'occupancy', [{ agreementId: 'a', unitId: 'u1', occupancy: 1 }, { agreementId: 'b', unitId: 'u2', occupancy: 2 }]);
  assert.deepEqual(occ.map((s) => s.shareCents), [100, 200]);
  const area = allocateUtility(300, 'area', [{ agreementId: 'a', unitId: 'u1', area: 50 }, { agreementId: 'b', unitId: 'u2', area: 100 }]);
  assert.deepEqual(area.map((s) => s.shareCents), [100, 200]);
  assert.deepEqual(allocateUtility(100, 'equal', []), []);
});

// --- endpoints ---------------------------------------------------------------

test('create a utility bill; the view carries the live allocation', () => {
  const app = mkApp();
  const r = create(app);
  assert.equal(r.status, 201);
  const b = r.body as { propertyName: string; allocation: Array<{ agreementId: string; shareCents: number; residentName: string; unitLabel: string }> };
  assert.equal(b.propertyName, 'Northgate');
  assert.equal(b.allocation.length, 2);
  assert.equal(b.allocation.reduce((n, s) => n + s.shareCents, 0), 90001); // sums to the master total
  assert.ok(b.allocation.some((s) => s.residentName === 'Resident 1' && s.unitLabel === 'Apt 101'));
});

test('unknown property 404; bad utility/method 400; bad total/dates rejected', () => {
  const app = mkApp();
  assert.equal(create(app, { id: 'u-x', propertyId: 'ghost' }).status, 404);
  assert.equal(create(app, { id: 'u-y', utility: 'plutonium' }).status, 400);
  assert.equal(create(app, { id: 'u-z', method: 'astrology' }).status, 400);
  assert.equal(create(app, { id: 'u-w', totalCents: 0 }).status, 409);
  assert.equal(create(app, { id: 'u-v', periodStart: '2026-07-01', periodEnd: '2026-06-01' }).status, 409);
});

test('billing raises a resident invoice per share through invoice.issue, summing to the total', () => {
  const app = mkApp(); create(app);
  const r = D(app, 'POST', '/utility-bills/util-1/bill', {});
  assert.equal(r.status, 200);
  const out = r.body as { billed: number; invoiceIds: string[]; bill: { status: string } };
  assert.equal(out.billed, 2);
  assert.equal(out.bill.status, 'billed');
  const totals = out.invoiceIds.map((id) => (D(app, 'GET', '/invoices/' + id).body as { totalCents: number }).totalCents);
  assert.equal(totals.reduce((a, b) => a + b, 0), 90001);
});

test('re-billing is idempotent — no duplicate resident invoices', () => {
  const app = mkApp(); create(app);
  D(app, 'POST', '/utility-bills/util-1/bill', {});
  const again = D(app, 'POST', '/utility-bills/util-1/bill', {});
  assert.equal((again.body as { billed: number }).billed, 0);
  // Only the two original utility invoices exist.
  const invIds = ['util-util-1-ag-1', 'util-util-1-ag-2'];
  invIds.forEach((id) => assert.equal(D(app, 'GET', '/invoices/' + id).status, 200));
});

test('the utility charge posts to a utility-reimbursement revenue account', () => {
  const app = mkApp(); create(app);
  D(app, 'POST', '/utility-bills/util-1/bill', {});
  const inv = D(app, 'GET', '/invoices/util-util-1-ag-1').body as { lines: Array<{ account: string }> };
  assert.equal(inv.lines[0]!.account, 'revenue:utility_reimbursement');
});

test('GET list and GET :id return the bill with its allocation', () => {
  const app = mkApp(); create(app);
  assert.equal((D(app, 'GET', '/utility-bills').body as { bills: unknown[] }).bills.length, 1);
  const one = D(app, 'GET', '/utility-bills/util-1').body as { allocation: unknown[] };
  assert.equal(one.allocation.length, 2);
});

test('utility.manage gates writes; read_only reads; front-of-house/agent cannot manage', () => {
  const app = mkApp(); create(app);
  assert.equal(D(app, 'GET', '/utility-bills', undefined, 'r').status, 200);
  assert.equal(create(app, { id: 'u-ro' }, 'r').status, 403);
  assert.equal(create(app, { id: 'u-bot' }, 'bot').status, 403); // agent is OPS, no utility.manage
  assert.equal(create(app, { id: 'u-acc' }, 'acc').status, 201); // accountant (finance) can
});

test('utility bills are tenant-scoped', () => {
  const app = mkApp(); create(app);
  const o2: AuthContext = { actor: 'o2', tenantId: 'other', role: 'owner' };
  const app2 = new App({ authenticator: new StaticTokenAuthenticator({ o2 }), now: () => NOW });
  app2.dispatch({ method: 'PUT', path: '/config', bearer: 'Bearer o2', body: { displayName: 'O', country: 'US' } });
  assert.equal((app2.dispatch({ method: 'GET', path: '/utility-bills', bearer: 'Bearer o2', body: {} }).body as { bills: unknown[] }).bills.length, 0);
  assert.equal(app2.dispatch({ method: 'GET', path: '/utility-bills/util-1', bearer: 'Bearer o2', body: {} }).status, 404);
});

test('only active residential leases in the property participate', () => {
  const app = mkApp();
  // A draft lease and a lease in another property must NOT participate.
  D(app, 'POST', '/units', { id: 'u-3', code: 'A-3', label: 'Apt 103', propertyId: 'prop-1' });
  D(app, 'POST', '/agreements', { id: 'ag-3', guestId: 'Draft', unitId: 'u-3', kind: 'lease', start: '2026-01-01', end: '2027-01-01', rateCents: 300000 });
  // ag-3 left in draft (not activated)
  const b = create(app).body as { allocation: unknown[] };
  assert.equal(b.allocation.length, 2); // only ag-1, ag-2 (active)
});

test('a utility bill projects to SQL and survives snapshot → rehydrate', () => {
  const app = mkApp(); create(app); D(app, 'POST', '/utility-bills/util-1/bill', {});
  const ins = projectWorld(app.snapshotWorld('mf')).find((x) => x.text.startsWith('insert into utility_bill '));
  assert.ok(ins);
  const b = new App({ authenticator: new StaticTokenAuthenticator({ own }), now: () => NOW });
  b.rehydrate(app.snapshotWorld('mf'));
  const bill = (b.snapshotWorld('mf').utilityBills ?? []).find((x) => x.id === 'util-1')!;
  assert.equal(bill.utility, 'water');
  assert.equal(bill.status, 'billed'); // the billed status persisted
  assert.equal(bill.totalCents, 90001);
});
