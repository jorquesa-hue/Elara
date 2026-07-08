// Tranche 10 — the operator money lifecycle end-to-end through the API, and the
// per-agreement billing rollup that backs the portal detail view. 3 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator } from '../src/api/context.ts';
import { ACCOUNTS } from '../src/billing.ts';

const T = '2026-07-01T00:00:00Z';

function ownerApp() {
  const auth = new StaticTokenAuthenticator({
    'tok': { actor: 'o', tenantId: 't-1', role: 'owner' },
    'tok-sp': { actor: 'x', tenantId: 't-2', role: 'owner' },
  });
  const app = new App({ authenticator: auth, units: [{ id: 'u-1', tenantId: 't-1' }], now: () => T });
  return app;
}
const b = (t: string) => `Bearer ${t}`;

function book(app: App) {
  app.dispatch({ method: 'POST', path: '/agreements', bearer: b('tok'), body: { id: 'ag-1', guestId: 'g-1', unitId: 'u-1', kind: 'nightly', start: '2026-07-01', end: '2026-07-10', rateCents: 20000 } });
  app.dispatch({ method: 'POST', path: '/agreements/ag-1/activate', bearer: b('tok'), body: {} });
}

test('full money lifecycle through the API leaves the ledger balanced', () => {
  const app = ownerApp();
  book(app);
  assert.equal(app.dispatch({ method: 'POST', path: '/invoices', bearer: b('tok'), body: { id: 'inv-1', agreementId: 'ag-1', dueAt: '2026-07-09', lines: [{ description: '9 nights', account: ACCOUNTS.roomRevenue, amountCents: 180000 }] } }).status, 201);
  assert.equal(app.dispatch({ method: 'POST', path: '/payments', bearer: b('tok'), body: { id: 'pay-1', invoiceId: 'inv-1', amountCents: 180000, method: 'pix' } }).status, 201);
  assert.equal(app.dispatch({ method: 'POST', path: '/deposits', bearer: b('tok'), body: { id: 'dep-1', agreementId: 'ag-1', amountCents: 50000 } }).status, 201);
  const refund = app.dispatch({ method: 'POST', path: '/deposits/dep-1/refund', bearer: b('tok'), body: { deductions: [{ reason: 'cleaning', amountCents: 8000 }] } });
  assert.equal(refund.status, 200);

  const tb = app.dispatch({ method: 'GET', path: '/ledger/trial-balance', bearer: b('tok') });
  assert.equal((tb.body as { balanced: boolean }).balanced, true);
});

test('billing rollup returns the agreement’s invoices, payments and deposits', () => {
  const app = ownerApp();
  book(app);
  app.dispatch({ method: 'POST', path: '/invoices', bearer: b('tok'), body: { id: 'inv-1', agreementId: 'ag-1', dueAt: '2026-07-09', lines: [{ description: '9 nights', account: ACCOUNTS.roomRevenue, amountCents: 180000 }] } });
  app.dispatch({ method: 'POST', path: '/payments', bearer: b('tok'), body: { id: 'pay-1', invoiceId: 'inv-1', amountCents: 60000, method: 'card' } });
  app.dispatch({ method: 'POST', path: '/deposits', bearer: b('tok'), body: { id: 'dep-1', agreementId: 'ag-1', amountCents: 50000 } });

  const res = app.dispatch({ method: 'GET', path: '/agreements/ag-1/billing', bearer: b('tok') });
  assert.equal(res.status, 200);
  const body = res.body as { invoices: unknown[]; payments: Array<{ amountCents: number }>; deposits: Array<{ status: string }> };
  assert.equal(body.invoices.length, 1);
  assert.equal(body.payments.length, 1);
  assert.equal(body.payments[0]!.amountCents, 60000);
  assert.equal(body.deposits[0]!.status, 'held');
  // Invoice is partially paid after a 60k payment on a 180k total.
  assert.equal((body.invoices[0] as { status: string }).status, 'partially_paid');
});

test('billing rollup is tenant-scoped (404 across tenants)', () => {
  const app = ownerApp();
  book(app);
  assert.equal(app.dispatch({ method: 'GET', path: '/agreements/ag-1/billing', bearer: b('tok-sp') }).status, 404);
});
