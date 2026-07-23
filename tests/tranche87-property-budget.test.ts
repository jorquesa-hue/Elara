// Tranche 87 — property operating budgets → NOI monitoring. A manager plans a
// community's revenue + expense lines; the App folds the ledger-derived actuals
// into a budget-vs-actual NOI view. Config-like → RBAC-only.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';
import { budgetTotals, budgetVsActual } from '../src/property-budget.ts';

const NOW = '2026-07-20T00:00:00Z';
const own: AuthContext = { actor: 'own', tenantId: 'mer', role: 'owner' };
const front: AuthContext = { actor: 'fd', tenantId: 'mer', role: 'front_desk' };
const D = (app: App, method: string, path: string, bearer: string, body?: Record<string, unknown>) =>
  app.dispatch({ method, path, bearer, body: body ?? {} });

function mkApp() {
  const app = new App({ authenticator: new StaticTokenAuthenticator({ own, fd: front }), units: [], now: () => NOW });
  D(app, 'PUT', '/config', 'Bearer own', { displayName: 'Meridian', country: 'GB' });
  D(app, 'POST', '/properties', 'Bearer own', { id: 'prop-ber', code: 'BER', name: 'Berlin Mitte' });
  return app;
}

const LINES = [
  { category: 'revenue', label: 'Base rent', amountCents: 1_000_000 },
  { category: 'expense', label: 'Repairs', amountCents: 200_000 },
  { category: 'expense', label: 'Utilities', amountCents: 100_000 },
];

test('budgetTotals + budgetVsActual are pure and net NOI correctly', () => {
  const t = budgetTotals(LINES as never);
  assert.equal(t.revenueCents, 1_000_000);
  assert.equal(t.expenseCents, 300_000);
  assert.equal(t.noiCents, 700_000);
  const v = budgetVsActual(LINES as never, { revenueCents: 900_000, expenseCents: 250_000, noiCents: 650_000 });
  assert.equal(v.budgeted.noiCents, 700_000);
  assert.equal(v.actual.noiCents, 650_000);
  assert.equal(v.variance.revenueCents, -100_000); // under plan on revenue
  assert.equal(v.variance.expenseCents, -50_000);  // under plan on expense (good)
  assert.equal(v.variance.noiCents, -50_000);
  assert.equal(v.budgetNoiMarginPct, 70);
});

test('create a property budget and read it back with a budget-vs-actual fold', () => {
  const app = mkApp();
  const r = D(app, 'POST', '/property-budgets', 'Bearer own', { propertyId: 'prop-ber', periodStart: '2026-01-01', periodEnd: '2026-12-31', lines: LINES });
  assert.equal(r.status, 201);
  const b = r.body as { id: string; propertyName: string; vsActual: { budgeted: { noiCents: number } } };
  assert.equal(b.propertyName, 'Berlin Mitte');
  assert.equal(b.vsActual.budgeted.noiCents, 700_000);
  const list = (D(app, 'GET', '/property-budgets', 'Bearer own').body as { budgets: unknown[] }).budgets;
  assert.equal(list.length, 1);
  const detail = D(app, 'GET', `/property-budgets/${b.id}`, 'Bearer own');
  assert.equal(detail.status, 200);
});

test('actuals come from the ledger scoped to the property', () => {
  const app = mkApp();
  // Book a lease on the property and collect a payment so revenue posts with the propertyId.
  D(app, 'POST', '/unit-types', 'Bearer own', { code: 'STD', name: 'Studio' });
  D(app, 'POST', '/units', 'Bearer own', { id: 'unit-BER-1', code: 'BER-1', label: 'Apt 1', propertyId: 'prop-ber' });
  D(app, 'POST', '/agreements', 'Bearer own', { id: 'agr-1', guestId: 'g1', unitId: 'unit-BER-1', kind: 'monthly', start: '2026-02-01', end: '2027-02-01', rateCents: 300_000 });
  D(app, 'POST', '/agreements/agr-1/activate', 'Bearer own', {});
  D(app, 'POST', '/invoices', 'Bearer own', { id: 'inv-1', agreementId: 'agr-1', dueAt: '2026-02-05', lines: [{ description: 'Feb rent', amountCents: 300_000, account: 'revenue:rent' }] });
  D(app, 'POST', '/payments', 'Bearer own', { id: 'pay-1', invoiceId: 'inv-1', amountCents: 300_000, method: 'cash', receivedAt: '2026-02-03T00:00:00Z' });
  D(app, 'POST', '/property-budgets', 'Bearer own', { id: 'pb-1', propertyId: 'prop-ber', periodStart: '2026-01-01', periodEnd: '2026-12-31', lines: LINES });
  const row = D(app, 'GET', '/property-budgets/pb-1', 'Bearer own').body as { vsActual: { actual: { revenueCents: number }; variance: { revenueCents: number } } };
  assert.equal(row.vsActual.actual.revenueCents, 300_000, 'invoiced revenue is the actual');
  assert.equal(row.vsActual.variance.revenueCents, -700_000, 'actual 300k − budget 1,000k');
});

test('validation: unknown property 404, bad line category 400, bad dates 409', () => {
  const app = mkApp();
  assert.equal(D(app, 'POST', '/property-budgets', 'Bearer own', { propertyId: 'nope', periodStart: '2026-01-01', periodEnd: '2026-12-31', lines: [] }).status, 404);
  assert.equal(D(app, 'POST', '/property-budgets', 'Bearer own', { propertyId: 'prop-ber', periodStart: '2026-01-01', periodEnd: '2026-12-31', lines: [{ category: 'bogus', label: 'x', amountCents: 1 }] }).status, 400);
  assert.equal(D(app, 'POST', '/property-budgets', 'Bearer own', { id: 'bad', propertyId: 'prop-ber', periodStart: '2026-12-31', periodEnd: '2026-01-01', lines: LINES }).status, 409);
});

test('RBAC: front desk reads but cannot manage; update replaces lines', () => {
  const app = mkApp();
  D(app, 'POST', '/property-budgets', 'Bearer own', { id: 'pb-2', propertyId: 'prop-ber', periodStart: '2026-01-01', periodEnd: '2026-12-31', lines: LINES });
  assert.equal(D(app, 'GET', '/property-budgets', 'Bearer fd').status, 200);            // read_only-ish (OPS read)
  assert.equal(D(app, 'POST', '/property-budgets', 'Bearer fd', { propertyId: 'prop-ber', periodStart: '2026-01-01', periodEnd: '2026-12-31', lines: LINES }).status, 403);
  const upd = D(app, 'PUT', '/property-budgets/pb-2', 'Bearer own', { lines: [{ category: 'revenue', label: 'Rent', amountCents: 500_000 }] });
  assert.equal(upd.status, 200);
  assert.equal((upd.body as { vsActual: { budgeted: { revenueCents: number } } }).vsActual.budgeted.revenueCents, 500_000);
});

test('property budgets survive a snapshot → rehydrate round trip', () => {
  const app = mkApp();
  D(app, 'POST', '/property-budgets', 'Bearer own', { id: 'pb-3', propertyId: 'prop-ber', periodStart: '2026-01-01', periodEnd: '2026-12-31', lines: LINES, notes: 'FY26 plan' });
  const world = app.snapshotWorld('mer');
  const app2 = new App({ authenticator: new StaticTokenAuthenticator({ own }), units: [], now: () => NOW });
  app2.rehydrate(world);
  const back = app2.propertyBudgets.get('pb-3');
  assert.equal(back.notes, 'FY26 plan');
  assert.equal(budgetTotals(back.lines).noiCents, 700_000);
});
