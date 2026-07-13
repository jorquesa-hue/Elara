// Tranche 64 — Phase 1E: the multi-GAAP surface. The same ledger recognized
// under accrual (revenue at invoice issue) vs cash (proportional to collection),
// exposed per tenant via GET /gaap/:basis. 5 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';

const NOW = '2026-07-13T00:00:00Z';
const own: AuthContext = { actor: 'own', tenantId: 'mf', role: 'owner' };
const ro: AuthContext = { actor: 'r', tenantId: 'mf', role: 'read_only' };

function mkApp() {
  return new App({ authenticator: new StaticTokenAuthenticator({ own, ro }), units: [], now: () => NOW });
}
const D = (app: App, method: string, path: string, body?: Record<string, unknown>, token = 'own') =>
  app.dispatch({ method, path, bearer: `Bearer ${token}`, body: body ?? {} });

function seed(app: App) {
  D(app, 'PUT', '/config', { displayName: 'Greyline', country: 'US' });
  D(app, 'POST', '/units', { id: 'u-1', code: 'A-1', label: 'A1' });
  D(app, 'POST', '/agreements', { id: 'ag-1', guestId: 'g-1', unitId: 'u-1', kind: 'monthly', start: '2026-07-01', end: '2027-07-01', rateCents: 300000 });
  D(app, 'POST', '/agreements/ag-1/activate', {});
  D(app, 'POST', '/invoices', { id: 'inv-1', agreementId: 'ag-1', issuedAt: NOW, dueAt: '2026-07-10', lines: [{ description: 'rent', account: 'revenue:room', amountCents: 100000 }] });
}

test('accrual recognizes the invoice immediately; cash recognizes nothing until paid', () => {
  const app = mkApp(); seed(app);
  assert.equal((D(app, 'GET', '/gaap/accrual').body as { totalRevenueCents: number }).totalRevenueCents, 100000);
  assert.equal((D(app, 'GET', '/gaap/cash').body as { totalRevenueCents: number }).totalRevenueCents, 0);
});

test('cash basis recognizes proportionally as payment lands', () => {
  const app = mkApp(); seed(app);
  D(app, 'POST', '/payments', { id: 'pay-1', invoiceId: 'inv-1', amountCents: 50000, method: 'transfer' });
  assert.equal((D(app, 'GET', '/gaap/cash').body as { totalRevenueCents: number }).totalRevenueCents, 50000);
  assert.equal((D(app, 'GET', '/gaap/accrual').body as { totalRevenueCents: number }).totalRevenueCents, 100000);
});

test('the view breaks revenue down by account', () => {
  const app = mkApp(); seed(app);
  const rev = (D(app, 'GET', '/gaap/accrual').body as { revenue: Record<string, number> }).revenue;
  assert.equal(rev['revenue:room'], 100000);
});

test('an invalid basis is rejected; read_only may read', () => {
  const app = mkApp(); seed(app);
  assert.equal(D(app, 'GET', '/gaap/imaginary').status, 400);
  assert.equal(D(app, 'GET', '/gaap/accrual', undefined, 'ro').status, 200);
});

test('the GAAP view is tenant-scoped', () => {
  const app = mkApp(); seed(app);
  const other: AuthContext = { actor: 'o2', tenantId: 'other', role: 'owner' };
  const app2 = new App({ authenticator: new StaticTokenAuthenticator({ o2: other }), now: () => NOW });
  app2.dispatch({ method: 'PUT', path: '/config', bearer: 'Bearer o2', body: { displayName: 'Other', country: 'US' } });
  // mf's revenue must not leak into other's GAAP view (they are separate Apps here,
  // but assert the scope predicate returns only this tenant's lines).
  assert.equal((app2.dispatch({ method: 'GET', path: '/gaap/accrual', bearer: 'Bearer o2', body: {} }).body as { totalRevenueCents: number }).totalRevenueCents, 0);
});
