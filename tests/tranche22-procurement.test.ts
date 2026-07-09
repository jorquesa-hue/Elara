// Tranche 22 — purchase orders & budgets (#2, the accounting depth beyond AR/AP).
// A PO is an ENCUMBRANCE, not a journal entry: raising/approving one commits
// budget but posts nothing to the ledger — the AP bill is what hits the GL. A
// budget folds three numbers per account/period: budgeted (plan), committed
// (open POs), actual (posted bills). Approving a PO above R$5k escalates through
// the policy envelope. 13 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Procurement, computeBudgetStatus, ProcurementError, type Budget } from '../src/procurement.ts';
import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';

const T = '2026-07-01T00:00:00Z';
const bearer = (t: string) => `Bearer ${t}`;
const D = (app: App, method: string, path: string, token: string, body?: Record<string, unknown>) =>
  app.dispatch({ method, path, bearer: bearer(token), body });

const EXPENSE = 'expenses:repairs';

// ---- pure kernel ---------------------------------------------------------

test('a PO lifecycle: draft → approved → received → closed', () => {
  const p = new Procurement();
  const po = p.raise({ id: 'po-1', tenantId: 't1', vendorId: 'v-1', createdAt: T, lines: [{ description: 'HVAC service', account: EXPENSE, amountCents: 120000 }] });
  assert.equal(po.status, 'draft');
  assert.equal(po.totalCents, 120000);
  assert.equal(p.approve('po-1', T).status, 'approved');
  assert.equal(p.receive('po-1', T).status, 'received');
  assert.equal(p.close('po-1', T).status, 'closed');
});

test('a draft PO commits nothing; approval encumbers the account/period', () => {
  const p = new Procurement();
  p.raise({ id: 'po-1', tenantId: 't1', vendorId: 'v-1', createdAt: '2026-07-05', lines: [{ description: 'x', account: EXPENSE, amountCents: 90000 }] });
  assert.equal(p.committedForAccount('t1', EXPENSE, '2026-07-01', '2026-08-01'), 0); // draft: no commitment
  p.approve('po-1', T);
  assert.equal(p.committedForAccount('t1', EXPENSE, '2026-07-01', '2026-08-01'), 90000);
  // closing releases the commitment
  p.close('po-1', T);
  assert.equal(p.committedForAccount('t1', EXPENSE, '2026-07-01', '2026-08-01'), 0);
});

test('commitment is bucketed by expectedAt and scoped to the account', () => {
  const p = new Procurement();
  p.raise({ id: 'po-1', tenantId: 't1', vendorId: 'v-1', createdAt: '2026-07-01', expectedAt: '2026-09-15', lines: [{ description: 'x', account: EXPENSE, amountCents: 50000 }] });
  p.approve('po-1', T);
  assert.equal(p.committedForAccount('t1', EXPENSE, '2026-07-01', '2026-08-01'), 0); // expected in Sep, not July
  assert.equal(p.committedForAccount('t1', EXPENSE, '2026-09-01', '2026-10-01'), 50000);
  assert.equal(p.committedForAccount('t1', 'expenses:other', '2026-09-01', '2026-10-01'), 0); // different account
});

test('recordBilling accrues and auto-closes when fully billed', () => {
  const p = new Procurement();
  p.raise({ id: 'po-1', tenantId: 't1', vendorId: 'v-1', createdAt: T, lines: [{ description: 'x', account: EXPENSE, amountCents: 100000 }] });
  p.approve('po-1', T);
  assert.equal(p.recordBilling('po-1', 40000, T).status, 'approved'); // partially billed → still open
  const done = p.recordBilling('po-1', 60000, T);
  assert.equal(done.status, 'closed');
  assert.equal(done.billedCents, 100000);
});

test('over-billing and cancelling a billed PO are rejected', () => {
  const p = new Procurement();
  p.raise({ id: 'po-1', tenantId: 't1', vendorId: 'v-1', createdAt: T, lines: [{ description: 'x', account: EXPENSE, amountCents: 100000 }] });
  p.approve('po-1', T);
  assert.throws(() => p.recordBilling('po-1', 120000, T), ProcurementError);
  p.recordBilling('po-1', 40000, T);
  assert.throws(() => p.cancel('po-1', T), ProcurementError); // billed → cannot cancel
});

test('bad transitions throw', () => {
  const p = new Procurement();
  p.raise({ id: 'po-1', tenantId: 't1', vendorId: 'v-1', createdAt: T, lines: [{ description: 'x', account: EXPENSE, amountCents: 100000 }] });
  assert.throws(() => p.receive('po-1', T), ProcurementError); // can't receive a draft
  assert.throws(() => p.raise({ id: 'po-1', tenantId: 't1', vendorId: 'v-1', createdAt: T, lines: [{ description: 'x', account: EXPENSE, amountCents: 1 }] }), ProcurementError); // dup
});

test('computeBudgetStatus folds budgeted / committed / actual into variance', () => {
  const b: Budget = { id: 'bg-1', tenantId: 't1', account: EXPENSE, periodStart: '2026-07-01', periodEnd: '2026-08-01', amountCents: 1_000_000 };
  const s = computeBudgetStatus(b, 300000, 250000);
  assert.equal(s.committedCents, 300000);
  assert.equal(s.actualCents, 250000);
  assert.equal(s.remainingCents, 450000); // 1_000_000 − 300000 − 250000
  assert.equal(s.usedPct, 55); // 550000 / 1_000_000
  assert.equal(s.overBudget, false);
  const over = computeBudgetStatus(b, 800000, 400000);
  assert.equal(over.overBudget, true);
  assert.equal(over.remainingCents, -200000);
});

test('budget validation rejects a bad period or negative amount', () => {
  const p = new Procurement();
  assert.throws(() => p.setBudget({ id: 'bg', tenantId: 't1', account: EXPENSE, periodStart: '2026-08-01', periodEnd: '2026-07-01', amountCents: 100 }), ProcurementError);
  assert.throws(() => p.setBudget({ id: 'bg', tenantId: 't1', account: EXPENSE, periodStart: '2026-07-01', periodEnd: '2026-08-01', amountCents: -1 }), ProcurementError);
});

// ---- through the Public API ----------------------------------------------

function makeApp() {
  const owner: AuthContext = { actor: 'ana', tenantId: 't1', role: 'owner' };
  const acct: AuthContext = { actor: 'fin', tenantId: 't1', role: 'accountant' };
  const desk: AuthContext = { actor: 'desk', tenantId: 't1', role: 'front_desk' };
  const reader: AuthContext = { actor: 'aud', tenantId: 't1', role: 'read_only' };
  const auth = new StaticTokenAuthenticator({ own: owner, fin: acct, desk, ro: reader });
  return new App({ authenticator: auth, now: () => T });
}
function addVendor(app: App) {
  D(app, 'POST', '/parties', 'own', { id: 'v-1', kind: 'organization', displayName: 'Acme Repairs' });
}

test('API: raise → approve → receive a PO; it appears in the list', () => {
  const app = makeApp();
  addVendor(app);
  const r = D(app, 'POST', '/purchase-orders', 'own', { id: 'po-1', vendorId: 'v-1', expectedAt: '2026-07-15', lines: [{ description: 'Roof repair', account: EXPENSE, amountCents: 200000 }] });
  assert.equal(r.status, 201);
  assert.equal((r.body as { status: string }).status, 'draft');
  assert.equal(D(app, 'POST', '/purchase-orders/po-1/approve', 'own', {}).status, 200);
  assert.equal((D(app, 'POST', '/purchase-orders/po-1/receive', 'own', {}).body as { status: string }).status, 'received');
  const list = D(app, 'GET', '/purchase-orders', 'own').body as { purchaseOrders: unknown[] };
  assert.equal(list.purchaseOrders.length, 1);
  // unknown vendor → 404
  assert.equal(D(app, 'POST', '/purchase-orders', 'own', { id: 'po-x', vendorId: 'nope', lines: [{ description: 'x', account: EXPENSE, amountCents: 1000 }] }).status, 404);
});

test('API: approving a PO above R$5,000 escalates through the policy envelope', () => {
  const app = makeApp();
  addVendor(app);
  D(app, 'POST', '/purchase-orders', 'own', { id: 'po-big', vendorId: 'v-1', lines: [{ description: 'Major reno', account: EXPENSE, amountCents: 600000 }] });
  const r = D(app, 'POST', '/purchase-orders/po-big/approve', 'own', {});
  assert.equal(r.status, 202); // escalated, not executed
  assert.equal((r.body as { status: string }).status, 'escalated');
  // it stays a draft (approval was NOT executed)
  assert.equal((D(app, 'GET', '/purchase-orders/po-big', 'own').body as { status: string }).status, 'draft');
});

test('API: a budget folds committed (open PO) + actual (posted bill)', () => {
  const app = makeApp();
  addVendor(app);
  D(app, 'POST', '/budgets', 'fin', { id: 'bg-1', account: EXPENSE, periodStart: '2026-07-01', periodEnd: '2026-08-01', amountCents: 1_000_000, label: 'July repairs' });
  // an approved PO expected in July commits 200000
  D(app, 'POST', '/purchase-orders', 'own', { id: 'po-1', vendorId: 'v-1', expectedAt: '2026-07-10', lines: [{ description: 'x', account: EXPENSE, amountCents: 200000 }] });
  D(app, 'POST', '/purchase-orders/po-1/approve', 'own', {});
  // a posted bill on the same account is the actual 150000
  D(app, 'POST', '/bills', 'own', { id: 'bill-1', payeeId: 'v-1', dueAt: '2026-07-20', issuedAt: '2026-07-08', lines: [{ description: 'parts', account: EXPENSE, amountCents: 150000 }] });
  const s = (D(app, 'GET', '/budgets/bg-1/status', 'fin').body as { status: { committedCents: number; actualCents: number; remainingCents: number } }).status;
  assert.equal(s.committedCents, 200000);
  assert.equal(s.actualCents, 150000);
  assert.equal(s.remainingCents, 650000); // 1_000_000 − 200000 − 150000
});

test('API: billing against a PO records billing and closes it when fully billed', () => {
  const app = makeApp();
  addVendor(app);
  D(app, 'POST', '/purchase-orders', 'own', { id: 'po-1', vendorId: 'v-1', expectedAt: '2026-07-10', lines: [{ description: 'x', account: EXPENSE, amountCents: 100000 }] });
  D(app, 'POST', '/purchase-orders/po-1/approve', 'own', {});
  const r = D(app, 'POST', '/bills', 'own', { id: 'bill-1', payeeId: 'v-1', dueAt: '2026-07-20', issuedAt: '2026-07-08', poId: 'po-1', lines: [{ description: 'full', account: EXPENSE, amountCents: 100000 }] });
  assert.equal(r.status, 201);
  const po = D(app, 'GET', '/purchase-orders/po-1', 'own').body as { status: string; billedCents: number };
  assert.equal(po.status, 'closed'); // fully billed → auto-closed
  assert.equal(po.billedCents, 100000);
});

test('API: RBAC — front desk reads but cannot manage; read_only cannot create budgets', () => {
  const app = makeApp();
  addVendor(app);
  assert.equal(D(app, 'GET', '/purchase-orders', 'desk').status, 200); // procurement.read in OPS
  assert.equal(D(app, 'POST', '/purchase-orders', 'desk', { id: 'po-1', vendorId: 'v-1', lines: [{ description: 'x', account: EXPENSE, amountCents: 1000 }] }).status, 403);
  assert.equal(D(app, 'POST', '/budgets', 'ro', { id: 'bg', account: EXPENSE, periodStart: '2026-07-01', periodEnd: '2026-08-01', amountCents: 100 }).status, 403);
});
