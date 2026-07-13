// Tranche 73 — Phase 4C: statement of cash flows. Opening → closing cash, with
// each cash movement classified by its journal-entry counterpart into operating
// (rent/expenses/AR/AP), investing (non-cash assets) and financing (deposits,
// loans, equity). 8 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';

const NOW = '2026-07-13T00:00:00Z';
const own: AuthContext = { actor: 'own', tenantId: 'mf', role: 'owner' };
const ro: AuthContext = { actor: 'r', tenantId: 'mf', role: 'read_only' };

function mkApp() {
  const app = new App({ authenticator: new StaticTokenAuthenticator({ own, ro }), units: [], now: () => NOW });
  D(app, 'PUT', '/config', { displayName: 'Greyline', country: 'US' });
  D(app, 'POST', '/units', { id: 'u-1', code: 'A-1', label: 'Apt 101' });
  D(app, 'POST', '/agreements', { id: 'ag-1', guestId: 'g-1', unitId: 'u-1', kind: 'monthly', start: '2026-07-01', end: '2027-07-01', rateCents: 300000 });
  D(app, 'POST', '/agreements/ag-1/activate', {});
  D(app, 'POST', '/parties', { id: 'pty-vendor', kind: 'organization', displayName: 'Ace Repairs' });
  return app;
}
const D = (app: App, method: string, path: string, body?: Record<string, unknown>, token = 'own') =>
  app.dispatch({ method, path, bearer: `Bearer ${token}`, body: body ?? {} });

type CF = { report: { rows: Array<{ section: string; amount: number }>; kpis: Array<{ label: string; value: number }> } };
function get(app: App, from = '2026-07-01', to = '2026-08-01') {
  return (D(app, 'GET', '/reports/cash_flow_statement', { from, to }).body as CF).report;
}
function section(r: CF['report'], name: string) { return r.rows.find((x) => x.section.startsWith(name))!.amount; }
function kpi(r: CF['report'], label: string) { return r.kpis.find((x) => x.label === label)!.value; }

test('a collected payment is an operating inflow', () => {
  const app = mkApp();
  D(app, 'POST', '/invoices', { id: 'inv-1', agreementId: 'ag-1', issuedAt: NOW, dueAt: '2026-07-20', lines: [{ description: 'rent', account: 'revenue:room', amountCents: 300000 }] });
  D(app, 'POST', '/payments', { id: 'pay-1', invoiceId: 'inv-1', amountCents: 300000, method: 'transfer' });
  const r = get(app);
  assert.equal(section(r, 'Operating'), 300000);
  assert.equal(kpi(r, 'Net change'), 300000);
  assert.equal(kpi(r, 'Closing cash'), 300000);
});

test('a deposit hold is a financing inflow', () => {
  const app = mkApp();
  D(app, 'POST', '/deposits', { id: 'dep-1', agreementId: 'ag-1', amountCents: 100000 });
  const r = get(app);
  assert.equal(section(r, 'Financing'), 100000);
  assert.equal(section(r, 'Operating'), 0);
});

test('a vendor payout is an operating outflow', () => {
  const app = mkApp();
  D(app, 'POST', '/bills', { id: 'b-1', payeeId: 'pty-vendor', dueAt: '2026-07-25', lines: [{ description: 'roof', account: 'expense:repairs', amountCents: 50000 }] });
  D(app, 'POST', '/bills/b-1/pay', { id: 'appay-b1', amountCents: 50000, method: 'transfer' });
  const r = get(app);
  assert.equal(section(r, 'Operating'), -50000);
});

test('operating, financing and net combine correctly', () => {
  const app = mkApp();
  D(app, 'POST', '/invoices', { id: 'inv-1', agreementId: 'ag-1', issuedAt: NOW, dueAt: '2026-07-20', lines: [{ description: 'rent', account: 'revenue:room', amountCents: 300000 }] });
  D(app, 'POST', '/payments', { id: 'pay-1', invoiceId: 'inv-1', amountCents: 300000, method: 'transfer' });
  D(app, 'POST', '/deposits', { id: 'dep-1', agreementId: 'ag-1', amountCents: 100000 });
  D(app, 'POST', '/bills', { id: 'b-1', payeeId: 'pty-vendor', dueAt: '2026-07-25', lines: [{ description: 'roof', account: 'expense:repairs', amountCents: 50000 }] });
  D(app, 'POST', '/bills/b-1/pay', { id: 'appay-b1', amountCents: 50000, method: 'transfer' });
  const r = get(app);
  assert.equal(section(r, 'Operating'), 250000); // +300k − 50k
  assert.equal(section(r, 'Financing'), 100000);
  assert.equal(kpi(r, 'Net change'), 350000);
  assert.equal(kpi(r, 'Closing cash'), 350000);
});

test('opening cash reflects movement before the window; closing carries it forward', () => {
  const app = mkApp();
  // A payment in June (before the window).
  D(app, 'POST', '/invoices', { id: 'inv-0', agreementId: 'ag-1', issuedAt: '2026-06-01T00:00:00Z', dueAt: '2026-06-10', lines: [{ description: 'rent', account: 'revenue:room', amountCents: 200000 }] });
  D(app, 'POST', '/payments', { id: 'pay-0', invoiceId: 'inv-0', amountCents: 200000, method: 'transfer', receivedAt: '2026-06-05T00:00:00Z' });
  // A payment in July (in the window).
  D(app, 'POST', '/invoices', { id: 'inv-1', agreementId: 'ag-1', issuedAt: NOW, dueAt: '2026-07-20', lines: [{ description: 'rent', account: 'revenue:room', amountCents: 300000 }] });
  D(app, 'POST', '/payments', { id: 'pay-1', invoiceId: 'inv-1', amountCents: 300000, method: 'transfer' });
  const r = get(app);
  assert.equal(kpi(r, 'Opening cash'), 200000);
  assert.equal(kpi(r, 'Net change'), 300000);
  assert.equal(kpi(r, 'Closing cash'), 500000);
});

test('an empty window is all zeros', () => {
  const app = mkApp();
  const r = get(app, '2027-01-01', '2027-02-01');
  assert.equal(kpi(r, 'Net change'), 0);
  assert.equal(kpi(r, 'Closing cash'), 0);
});

test('the statement is in the report catalog and reads via the endpoint', () => {
  const app = mkApp();
  const catalog = (D(app, 'GET', '/reports/catalog').body as { reports: Array<{ key: string }> }).reports;
  assert.ok(catalog.some((c) => c.key === 'cash_flow_statement'));
  assert.equal(D(app, 'GET', '/reports/cash_flow_statement', { from: '2026-07-01', to: '2026-08-01' }).status, 200);
});

test('read_only may read the statement of cash flows', () => {
  const app = mkApp();
  assert.equal(D(app, 'GET', '/reports/cash_flow_statement', { from: '2026-07-01', to: '2026-08-01' }, 'ro').status, 200);
});
