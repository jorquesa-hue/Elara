// Tranche 71 — Phase 4A: per-property expense allocation on AP bills. A bill can
// name the community it belongs to; its expense journal lines then carry that
// propertyId, so the owner statement attributes operating expenses to a property
// (real per-community NOI) instead of folding them into "Unassigned". 8 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';
import { projectWorld } from '../src/persistence/project.ts';

const NOW = '2026-07-13T00:00:00Z';
const own: AuthContext = { actor: 'own', tenantId: 'mf', role: 'owner' };

function mkApp() {
  const app = new App({ authenticator: new StaticTokenAuthenticator({ own }), units: [], now: () => NOW });
  D(app, 'PUT', '/config', { displayName: 'Greyline', country: 'US' });
  D(app, 'POST', '/legal-entities', { id: 'spe-north', role: 'spe', name: 'North SPE LLC' });
  D(app, 'POST', '/properties', { id: 'prop-north', code: 'NORTH', name: 'Northgate', entityId: 'spe-north' });
  D(app, 'POST', '/properties', { id: 'prop-south', code: 'SOUTH', name: 'Southgate' });
  D(app, 'POST', '/units', { id: 'u-1', code: 'A-1', label: 'Apt 101', propertyId: 'prop-north' });
  D(app, 'POST', '/agreements', { id: 'ag-1', guestId: 'g-1', unitId: 'u-1', kind: 'monthly', start: '2026-07-01', end: '2027-07-01', rateCents: 300000 });
  D(app, 'POST', '/agreements/ag-1/activate', {});
  D(app, 'POST', '/invoices', { id: 'inv-1', agreementId: 'ag-1', issuedAt: NOW, dueAt: '2026-07-20', lines: [{ description: 'rent', account: 'revenue:room', amountCents: 300000 }] });
  D(app, 'POST', '/parties', { id: 'pty-vendor', kind: 'organization', displayName: 'Ace Repairs' });
  return app;
}
const D = (app: App, method: string, path: string, body?: Record<string, unknown>, token = 'own') =>
  app.dispatch({ method, path, bearer: `Bearer ${token}`, body: body ?? {} });

function bill(app: App, over: Record<string, unknown> = {}) {
  return D(app, 'POST', '/bills', { id: 'b-1', payeeId: 'pty-vendor', propertyId: 'prop-north', dueAt: '2026-07-25', lines: [{ description: 'roof repair', account: 'expense:repairs', amountCents: 50000 }], ...over });
}

test('a bill stamps its propertyId onto the expense journal lines', () => {
  const app = mkApp(); bill(app);
  const lines = app.snapshotWorld('mf').journalLines.filter((l) => l.entryId === 'bill-b-1' && l.account === 'expense:repairs');
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.propertyId, 'prop-north');
});

test('an unknown property on a bill 404s', () => {
  const app = mkApp();
  assert.equal(bill(app, { propertyId: 'ghost' }).status, 404);
});

test('a bill with no property still books (propertyId undefined)', () => {
  const app = mkApp(); bill(app, { propertyId: undefined });
  const lines = app.snapshotWorld('mf').journalLines.filter((l) => l.entryId === 'bill-b-1' && l.account === 'expense:repairs');
  assert.equal(lines[0]!.propertyId, undefined);
});

test('the owner statement attributes the expense to its community (real NOI)', () => {
  const app = mkApp(); bill(app);
  const report = (D(app, 'GET', '/reports/owner_statement', { from: '2026-07-01', to: '2026-08-01' }).body as { report: { rows: Array<{ property: string; revenue: number; expenses: number; noi: number }> } }).report;
  const north = report.rows.find((r) => r.property === 'Northgate')!;
  assert.equal(north.revenue, 300000);
  assert.equal(north.expenses, 50000);
  assert.equal(north.noi, 250000);
  // The expense is NOT dumped into "Unassigned".
  const unassigned = report.rows.find((r) => r.property === 'Unassigned');
  assert.ok(!unassigned || unassigned.expenses === 0);
});

test('a bill on another community books its expense to THAT community', () => {
  const app = mkApp();
  bill(app);
  D(app, 'POST', '/bills', { id: 'b-2', payeeId: 'pty-vendor', propertyId: 'prop-south', dueAt: '2026-07-25', lines: [{ description: 'landscaping', account: 'expense:grounds', amountCents: 20000 }] });
  const report = (D(app, 'GET', '/reports/owner_statement', { from: '2026-07-01', to: '2026-08-01' }).body as { report: { rows: Array<{ property: string; expenses: number }> } }).report;
  assert.equal(report.rows.find((r) => r.property === 'Northgate')!.expenses, 50000);
  assert.equal(report.rows.find((r) => r.property === 'Southgate')!.expenses, 20000);
});

test('the owning entity is carried onto the owner-statement row', () => {
  const app = mkApp(); bill(app);
  const report = (D(app, 'GET', '/reports/owner_statement', { from: '2026-07-01', to: '2026-08-01' }).body as { report: { rows: Array<{ property: string; owner: string }> } }).report;
  assert.equal(report.rows.find((r) => r.property === 'Northgate')!.owner, 'North SPE LLC');
});

test('the bill projects to SQL with property_id', () => {
  const app = mkApp(); bill(app);
  const ins = projectWorld(app.snapshotWorld('mf')).find((s) => s.text.startsWith('insert into bill '));
  assert.ok(ins);
  assert.ok(ins!.text.includes('property_id'));
  assert.equal(ins!.values.includes('prop-north'), true);
});

test('the bill property survives snapshot → rehydrate', () => {
  const app = mkApp(); bill(app);
  const b = new App({ authenticator: new StaticTokenAuthenticator({ own }), now: () => NOW });
  b.rehydrate(app.snapshotWorld('mf'));
  const lines = b.snapshotWorld('mf').journalLines.filter((l) => l.entryId === 'bill-b-1' && l.account === 'expense:repairs');
  assert.equal(lines[0]!.propertyId, 'prop-north');
});
