// Tranche 61 — Phase 1B: entity/property on journal lines + owner statements.
// Money now books to a legal entity (charge routing) AND a property/community,
// so financial statements (income statement, GL, owner statement) can be
// produced per SPE and per community — the institutional fund report. Verifies
// the journal-line stamp on invoice + payment, the owner statement math, the
// per-property financial scope, the builder ledger dimensions, the projection
// SQL and the snapshot→rehydrate round trip. 9 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';
import { projectWorld } from '../src/persistence/project.ts';

const NOW = '2026-07-13T00:00:00Z';
const own: AuthContext = { actor: 'own', tenantId: 'mf', role: 'owner' };

function mkApp() {
  return new App({ authenticator: new StaticTokenAuthenticator({ own }), units: [], now: () => NOW });
}
const D = (app: App, method: string, path: string, body?: Record<string, unknown>, token: string | null = 'own') =>
  app.dispatch({ method, path, ...(token ? { bearer: `Bearer ${token}` } : {}), body: body ?? {} });

/** A tenant with an operating entity, a property owned by an SPE, a unit in it,
 *  a charge type routing rent → the operator, and an active monthly agreement. */
function seed(app: App) {
  D(app, 'PUT', '/config', { displayName: 'Greyline', country: 'US' });
  D(app, 'POST', '/legal-entities', { id: 'op', role: 'operator', name: 'Greyline Op' });
  D(app, 'POST', '/legal-entities', { id: 'spe-a', role: 'spe', name: 'Alpha Owner LLC' });
  D(app, 'POST', '/charge-types', { id: 'ct-rent', code: 'rent', name: 'Rent', receivingEntityId: 'op', glAccount: 'revenue:room', recurring: true });
  D(app, 'POST', '/properties', { code: 'A', name: 'Alpha', entityId: 'spe-a' });
  D(app, 'POST', '/units', { id: 'u-a1', code: 'A-1', label: 'Apt A1', propertyId: 'prop-a' });
  D(app, 'POST', '/agreements', { id: 'ag-1', guestId: 'g-1', unitId: 'u-a1', kind: 'monthly', start: '2026-07-01', end: '2027-07-01', rateCents: 300000 });
  D(app, 'POST', '/agreements/ag-1/activate', {});
}

test('a charge-routed invoice stamps entity + property on its journal lines', () => {
  const app = mkApp(); seed(app);
  const r = D(app, 'POST', '/invoices', { id: 'inv-1', agreementId: 'ag-1', dueAt: '2026-07-10', lines: [{ description: 'July rent', chargeCode: 'rent', amountCents: 300000 }] });
  assert.equal(r.status, 201);
  const world = app.snapshotWorld('mf');
  const revLine = world.journalLines.find((l) => l.account === 'revenue:room')!;
  assert.equal(revLine.entityId, 'op');       // receiving entity (charge routing)
  assert.equal(revLine.propertyId, 'prop-a'); // the agreement's unit's property
});

test('a payment books cash/AR to the same entity + property', () => {
  const app = mkApp(); seed(app);
  D(app, 'POST', '/invoices', { id: 'inv-1', agreementId: 'ag-1', dueAt: '2026-07-10', lines: [{ description: 'rent', chargeCode: 'rent', amountCents: 300000 }] });
  D(app, 'POST', '/payments', { id: 'pay-1', invoiceId: 'inv-1', amountCents: 300000, method: 'transfer' });
  const cash = app.snapshotWorld('mf').journalLines.find((l) => l.account === 'assets:cash')!;
  assert.equal(cash.entityId, 'op');
  assert.equal(cash.propertyId, 'prop-a');
});

test('the owner statement reports NOI by property with the owning entity', () => {
  const app = mkApp(); seed(app);
  D(app, 'POST', '/invoices', { id: 'inv-1', agreementId: 'ag-1', issuedAt: NOW, dueAt: '2026-07-10', lines: [{ description: 'rent', chargeCode: 'rent', amountCents: 300000 }] });
  const rep = (D(app, 'GET', '/reports/owner_statement').body as { report: { rows: Array<{ property: string; owner: string; revenue: number; noi: number }>; kpis: Array<{ label: string; value: number }> } }).report;
  const alpha = rep.rows.find((r) => r.property === 'Alpha')!;
  assert.equal(alpha.owner, 'Alpha Owner LLC');
  assert.equal(alpha.revenue, 300000);
  assert.equal(alpha.noi, 300000);
  assert.equal(rep.kpis.find((k) => /net operating/i.test(k.label))!.value, 300000);
});

test('owner_statement is in the report catalog', () => {
  const app = mkApp(); seed(app);
  const cat = (D(app, 'GET', '/reports/catalog').body as { reports: Array<{ key: string }> }).reports;
  assert.ok(cat.some((r) => r.key === 'owner_statement'));
});

test('?propertyId scopes the income statement to one community', () => {
  const app = mkApp(); seed(app);
  // A second property with its own unit + agreement + invoice.
  D(app, 'POST', '/properties', { code: 'B', name: 'Bravo' });
  D(app, 'POST', '/units', { id: 'u-b1', code: 'B-1', label: 'B1', propertyId: 'prop-b' });
  D(app, 'POST', '/agreements', { id: 'ag-2', guestId: 'g-2', unitId: 'u-b1', kind: 'monthly', start: '2026-07-01', end: '2027-07-01', rateCents: 100000 });
  D(app, 'POST', '/agreements/ag-2/activate', {});
  D(app, 'POST', '/invoices', { id: 'inv-1', agreementId: 'ag-1', issuedAt: NOW, dueAt: '2026-07-10', lines: [{ description: 'rent', chargeCode: 'rent', amountCents: 300000 }] });
  D(app, 'POST', '/invoices', { id: 'inv-2', agreementId: 'ag-2', issuedAt: NOW, dueAt: '2026-07-10', lines: [{ description: 'rent', chargeCode: 'rent', amountCents: 100000 }] });
  const allRev = (D(app, 'GET', '/reports/income_statement').body as { report: { kpis: Array<{ label: string; value: number }> } }).report.kpis.find((k) => k.label === 'Revenue')!.value;
  assert.equal(allRev, 400000);
  const aRev = (D(app, 'GET', '/reports/income_statement', { propertyId: 'prop-a' }).body as { report: { kpis: Array<{ label: string; value: number }> } }).report.kpis.find((k) => k.label === 'Revenue')!.value;
  assert.equal(aRev, 300000); // only Alpha's revenue
});

test('the report builder can group the ledger by property and by entity', () => {
  const app = mkApp(); seed(app);
  D(app, 'POST', '/invoices', { id: 'inv-1', agreementId: 'ag-1', issuedAt: NOW, dueAt: '2026-07-10', lines: [{ description: 'rent', chargeCode: 'rent', amountCents: 300000 }] });
  const sources = (D(app, 'GET', '/reports/build/sources').body as { sources: Array<{ key: string; dimensions: Array<{ key: string }> }> }).sources;
  const dims = sources.find((s) => s.key === 'ledger')!.dimensions.map((d) => d.key);
  assert.ok(dims.includes('property'));
  assert.ok(dims.includes('entity'));
  const built = D(app, 'POST', '/reports/build', { source: 'ledger', dimension: 'property', measure: 'credits' });
  assert.equal(built.status, 200);
  const rows = (built.body as { report: { rows: Array<{ label: string; value: number }> } }).report.rows;
  assert.ok(rows.some((r) => r.label === 'prop-a'));
});

test('projection emits entity_id + property_id on journal_line', () => {
  const app = mkApp(); seed(app);
  D(app, 'POST', '/invoices', { id: 'inv-1', agreementId: 'ag-1', dueAt: '2026-07-10', lines: [{ description: 'rent', chargeCode: 'rent', amountCents: 300000 }] });
  const stmts = projectWorld(app.snapshotWorld('mf'));
  const jl = stmts.find((s) => s.text.startsWith('insert into journal_line') && s.values.includes('revenue:room'))!;
  assert.ok(jl.text.includes('entity_id'));
  assert.ok(jl.text.includes('property_id'));
  assert.ok(jl.values.includes('op'));
  assert.ok(jl.values.includes('prop-a'));
});

test('journal-line entity/property survive snapshot → rehydrate', () => {
  const app = mkApp(); seed(app);
  D(app, 'POST', '/invoices', { id: 'inv-1', agreementId: 'ag-1', issuedAt: NOW, dueAt: '2026-07-10', lines: [{ description: 'rent', chargeCode: 'rent', amountCents: 300000 }] });
  const b = mkApp();
  b.rehydrate(app.snapshotWorld('mf'));
  const rep = (D(b, 'GET', '/reports/owner_statement').body as { report: { rows: Array<{ property: string; revenue: number }> } }).report;
  assert.equal(rep.rows.find((r) => r.property === 'Alpha')?.revenue, 300000);
});

test('condo pass-through routes to a different entity, still property-stamped', () => {
  const app = mkApp(); seed(app);
  D(app, 'POST', '/legal-entities', { id: 'condo', role: 'condominium', name: 'Alpha Condo' });
  D(app, 'POST', '/charge-types', { id: 'ct-condo', code: 'condo_fee', name: 'Condo', receivingEntityId: 'condo', glAccount: 'liabilities:due_to_condominium', recurring: true });
  D(app, 'POST', '/invoices', { id: 'inv-c', agreementId: 'ag-1', dueAt: '2026-07-10', lines: [{ description: 'condo', chargeCode: 'condo_fee', amountCents: 30000 }] });
  const line = app.snapshotWorld('mf').journalLines.find((l) => l.account === 'liabilities:due_to_condominium')!;
  assert.equal(line.entityId, 'condo');       // NOT the operator
  assert.equal(line.propertyId, 'prop-a');    // still the community
});
