// Tranche 72 — Phase 4B: monthly budget buckets. A period budget split evenly
// across its months, with posted bill spend bucketed per month, so a manager
// sees the burn month by month (not just one period total). 9 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';
import { monthsInWindow, monthlyBudgetBuckets, type Budget } from '../src/procurement.ts';

const NOW = '2026-07-13T00:00:00Z';
const own: AuthContext = { actor: 'own', tenantId: 'mf', role: 'owner' };
const ro: AuthContext = { actor: 'r', tenantId: 'mf', role: 'read_only' };

function mkApp() {
  const app = new App({ authenticator: new StaticTokenAuthenticator({ own, ro }), units: [], now: () => NOW });
  D(app, 'PUT', '/config', { displayName: 'Greyline', country: 'US' });
  D(app, 'POST', '/parties', { id: 'pty-vendor', kind: 'organization', displayName: 'Ace Repairs' });
  // A quarterly repairs budget of 900k across Jul–Sep 2026 (3 months → 300k/mo).
  D(app, 'POST', '/budgets', { id: 'bud-1', account: 'expense:repairs', periodStart: '2026-07-01', periodEnd: '2026-10-01', amountCents: 900000, label: 'Q3 repairs' });
  return app;
}
const D = (app: App, method: string, path: string, body?: Record<string, unknown>, token = 'own') =>
  app.dispatch({ method, path, bearer: `Bearer ${token}`, body: body ?? {} });

const budget: Budget = { id: 'b', tenantId: 'mf', account: 'expense:repairs', periodStart: '2026-07-01', periodEnd: '2026-10-01', amountCents: 900000 };

// --- pure module ----------------------------------------------------------
test('monthsInWindow enumerates the months of a [start, end) window', () => {
  assert.deepEqual(monthsInWindow('2026-07-01', '2026-10-01'), ['2026-07', '2026-08', '2026-09']);
  // An end that lands mid-month includes that month.
  assert.deepEqual(monthsInWindow('2026-07-01', '2026-08-15'), ['2026-07', '2026-08']);
  // A single-month window.
  assert.deepEqual(monthsInWindow('2026-07-01', '2026-08-01'), ['2026-07']);
});

test('monthlyBudgetBuckets splits evenly and the parts sum to the period total', () => {
  const buckets = monthlyBudgetBuckets(budget, new Map());
  assert.equal(buckets.length, 3);
  assert.equal(buckets.reduce((n, b) => n + b.budgetedCents, 0), 900000);
  assert.equal(buckets[0]!.budgetedCents, 300000);
});

test('an uneven split carries the remainder onto the last month', () => {
  const b: Budget = { ...budget, amountCents: 1000 }; // 1000 / 3 = 333 r1
  const buckets = monthlyBudgetBuckets(b, new Map());
  assert.deepEqual(buckets.map((x) => x.budgetedCents), [333, 333, 334]);
});

test('actuals bucket into their month and compute variance', () => {
  const buckets = monthlyBudgetBuckets(budget, new Map([['2026-08', 320000]]));
  const aug = buckets.find((x) => x.month === '2026-08')!;
  assert.equal(aug.actualCents, 320000);
  assert.equal(aug.varianceCents, -20000); // over the 300k monthly budget
  assert.equal(aug.overBudget, true);
  const jul = buckets.find((x) => x.month === '2026-07')!;
  assert.equal(jul.varianceCents, 300000); // nothing spent → fully under
});

// --- endpoint -------------------------------------------------------------
test('GET /budgets/:id/monthly returns per-month buckets from posted bills', () => {
  const app = mkApp();
  // Two bills posted in different months against the budgeted account.
  D(app, 'POST', '/bills', { id: 'b-jul', payeeId: 'pty-vendor', issuedAt: '2026-07-10T00:00:00Z', dueAt: '2026-07-20', lines: [{ description: 'roof', account: 'expense:repairs', amountCents: 250000 }] });
  D(app, 'POST', '/bills', { id: 'b-aug', payeeId: 'pty-vendor', issuedAt: '2026-08-05T00:00:00Z', dueAt: '2026-08-20', lines: [{ description: 'hvac', account: 'expense:repairs', amountCents: 340000 }] });
  const buckets = (D(app, 'GET', '/budgets/bud-1/monthly').body as { buckets: Array<{ month: string; budgetedCents: number; actualCents: number; overBudget: boolean }> }).buckets;
  assert.equal(buckets.length, 3);
  assert.equal(buckets.find((b) => b.month === '2026-07')!.actualCents, 250000);
  assert.equal(buckets.find((b) => b.month === '2026-08')!.actualCents, 340000);
  assert.equal(buckets.find((b) => b.month === '2026-08')!.overBudget, true);
  assert.equal(buckets.find((b) => b.month === '2026-09')!.actualCents, 0);
});

test('only the budgeted account and non-void bills count', () => {
  const app = mkApp();
  D(app, 'POST', '/bills', { id: 'b-1', payeeId: 'pty-vendor', issuedAt: '2026-07-10T00:00:00Z', dueAt: '2026-07-20', lines: [{ description: 'x', account: 'expense:cleaning', amountCents: 999000 }] });
  const buckets = (D(app, 'GET', '/budgets/bud-1/monthly').body as { buckets: Array<{ actualCents: number }> }).buckets;
  assert.equal(buckets.reduce((n, b) => n + b.actualCents, 0), 0); // different account
});

test('a bill outside the budget window is excluded', () => {
  const app = mkApp();
  D(app, 'POST', '/bills', { id: 'b-oct', payeeId: 'pty-vendor', issuedAt: '2026-10-10T00:00:00Z', dueAt: '2026-10-20', lines: [{ description: 'x', account: 'expense:repairs', amountCents: 100000 }] });
  const buckets = (D(app, 'GET', '/budgets/bud-1/monthly').body as { buckets: Array<{ actualCents: number }> }).buckets;
  assert.equal(buckets.reduce((n, b) => n + b.actualCents, 0), 0);
});

test('an unknown budget 404s; read_only may read', () => {
  const app = mkApp();
  assert.equal(D(app, 'GET', '/budgets/nope/monthly').status, 404);
  assert.equal(D(app, 'GET', '/budgets/bud-1/monthly', undefined, 'ro').status, 200);
});

test('the monthly view is tenant-scoped', () => {
  const app = mkApp();
  const other: AuthContext = { actor: 'o2', tenantId: 'other', role: 'owner' };
  const app2 = new App({ authenticator: new StaticTokenAuthenticator({ o2: other }), now: () => NOW });
  app2.dispatch({ method: 'PUT', path: '/config', bearer: 'Bearer o2', body: { displayName: 'Other', country: 'US' } });
  assert.equal(app2.dispatch({ method: 'GET', path: '/budgets/bud-1/monthly', bearer: 'Bearer o2', body: {} }).status, 404);
});
