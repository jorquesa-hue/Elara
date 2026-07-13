// Tranche 60 — Phase 1A: the property / community dimension. A multi-property
// operator groups units into properties; reports, occupancy and (later) books
// roll up per community. CRUD + validation, unit linkage, bulk + CSV, the
// rent-roll Property column, per-property report scoping, projection SQL, the
// snapshot→rehydrate round trip, and the demo seed. 11 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';
import { projectWorld } from '../src/persistence/project.ts';

const NOW = '2026-07-13T00:00:00Z';
const mgr: AuthContext = { actor: 'm', tenantId: 'mf', role: 'owner' };

function mkApp() {
  return new App({ authenticator: new StaticTokenAuthenticator({ mgr }), now: () => NOW });
}
const D = (app: App, method: string, path: string, body?: Record<string, unknown>, token: string | null = 'mgr') =>
  app.dispatch({ method, path, ...(token ? { bearer: `Bearer ${token}` } : {}), body: body ?? {} });
function setup(app: App) { D(app, 'PUT', '/config', { displayName: 'Greyline', country: 'US' }); }

test('property CRUD; unknown owning entity 404', () => {
  const app = mkApp(); setup(app);
  const res = D(app, 'POST', '/properties', { code: 'GREYSTONE', name: 'Greystone at Riverside', address: '1 River Rd' });
  assert.equal(res.status, 201);
  const pr = res.body as { id: string; name: string };
  assert.equal(pr.id, 'prop-greystone');
  assert.equal(D(app, 'PUT', `/properties/${pr.id}`, { name: 'Greystone Residences' }).status, 200);
  assert.equal((D(app, 'GET', '/properties').body as { properties: unknown[] }).properties.length, 1);
  assert.equal(D(app, 'POST', '/properties', { code: 'X', name: 'X', entityId: 'le-nope' }).status, 404);
});

test('a property can link to an owning legal entity', () => {
  const app = mkApp(); setup(app);
  D(app, 'POST', '/legal-entities', { id: 'le-spe', role: 'spe', name: 'Riverside SPE LLC' });
  const pr = D(app, 'POST', '/properties', { code: 'RV', name: 'Riverside', entityId: 'le-spe' }).body as { entityId?: string };
  assert.equal(pr.entityId, 'le-spe');
});

test('a unit links to a property; unknown 404; re-link and unlink', () => {
  const app = mkApp(); setup(app);
  D(app, 'POST', '/properties', { code: 'A', name: 'Alpha' });
  D(app, 'POST', '/properties', { code: 'B', name: 'Bravo' });
  assert.equal(D(app, 'POST', '/units', { id: 'u-x', code: 'X', label: 'X', propertyId: 'prop-nope' }).status, 404);
  const u = D(app, 'POST', '/units', { id: 'u-1', code: 'A-101', label: 'Apt 101', propertyId: 'prop-a' }).body as { propertyId?: string };
  assert.equal(u.propertyId, 'prop-a');
  assert.equal((D(app, 'PUT', '/units/u-1', { propertyId: 'prop-b' }).body as { propertyId?: string }).propertyId, 'prop-b');
  assert.equal((D(app, 'PUT', '/units/u-1', { propertyId: '' }).body as { propertyId?: string }).propertyId, undefined);
});

test('bulk generation links every unit to a property', () => {
  const app = mkApp(); setup(app);
  D(app, 'POST', '/properties', { code: 'TWR', name: 'Tower A' });
  const r = D(app, 'POST', '/units/bulk', { codePrefix: 'TWR-', count: 10, startNumber: 101, propertyId: 'prop-twr' });
  assert.equal((r.body as { created: number }).created, 10);
  const md = D(app, 'GET', '/master-data').body as { units: Array<{ propertyId?: string }> };
  assert.ok(md.units.every((u) => u.propertyId === 'prop-twr'));
});

test('CSV import auto-creates properties from a property column', () => {
  const app = mkApp(); setup(app);
  const csv = 'unit,name,property\nA-101,Apt 101,Alpha\nA-102,Apt 102,Alpha\nB-201,Apt 201,Bravo\n';
  assert.equal(D(app, 'POST', '/onboarding/commit', { target: 'units', csv }).status, 201);
  const props = (D(app, 'GET', '/properties').body as { properties: Array<{ id: string }> }).properties.map((p) => p.id).sort();
  assert.deepEqual(props, ['prop-alpha', 'prop-bravo']);
  const md = D(app, 'GET', '/master-data').body as { units: Array<{ code: string; propertyId?: string }> };
  assert.equal(md.units.find((u) => u.code === 'B-201')?.propertyId, 'prop-bravo');
});

test('rent roll carries a Property column', () => {
  const app = mkApp(); setup(app);
  D(app, 'POST', '/properties', { code: 'A', name: 'Alpha' });
  D(app, 'POST', '/units', { id: 'u-1', code: 'A-1', label: 'Apt A1', propertyId: 'prop-a' });
  const rep = (D(app, 'GET', '/reports/rent_roll').body as { report: { columns: Array<{ key: string }>; rows: Array<{ unit: string; property: string }> } }).report;
  assert.ok(rep.columns.some((c) => c.key === 'property'));
  assert.equal(rep.rows.find((r) => r.unit === 'Apt A1')?.property, 'Alpha');
});

test('?propertyId scopes the rent roll to one community', () => {
  const app = mkApp(); setup(app);
  D(app, 'POST', '/properties', { code: 'A', name: 'Alpha' });
  D(app, 'POST', '/properties', { code: 'B', name: 'Bravo' });
  D(app, 'POST', '/units', { id: 'u-a1', code: 'A-1', label: 'Apt A1', propertyId: 'prop-a' });
  D(app, 'POST', '/units', { id: 'u-a2', code: 'A-2', label: 'Apt A2', propertyId: 'prop-a' });
  D(app, 'POST', '/units', { id: 'u-b1', code: 'B-1', label: 'Apt B1', propertyId: 'prop-b' });
  const all = (D(app, 'GET', '/reports/rent_roll').body as { report: { rows: unknown[] } }).report.rows;
  assert.equal(all.length, 3);
  const scoped = (D(app, 'GET', '/reports/rent_roll', { propertyId: 'prop-a' }).body as { report: { rows: Array<{ unit: string }> } }).report.rows;
  assert.equal(scoped.length, 2);
  assert.ok(scoped.every((r) => r.unit.startsWith('Apt A')));
});

test('per-property scope also narrows occupancy to the community', () => {
  const app = mkApp(); setup(app);
  D(app, 'POST', '/properties', { code: 'A', name: 'Alpha' });
  D(app, 'POST', '/properties', { code: 'B', name: 'Bravo' });
  D(app, 'POST', '/units', { id: 'u-a1', code: 'A-1', label: 'A1', propertyId: 'prop-a' });
  D(app, 'POST', '/units', { id: 'u-b1', code: 'B-1', label: 'B1', propertyId: 'prop-b' });
  // Occupy the Alpha unit.
  D(app, 'POST', '/agreements', { id: 'ag-1', guestId: 'g-1', unitId: 'u-a1', kind: 'monthly', start: '2026-07-01', end: '2027-07-01', rateCents: 300000 });
  D(app, 'POST', '/agreements/ag-1/activate', {});
  const kpi = (body: unknown, re: RegExp) => ((body as { report: { kpis: Array<{ label: string; value: number }> } }).report.kpis.find((k) => re.test(k.label))!).value;
  const a = D(app, 'GET', '/reports/occupancy', { propertyId: 'prop-a' }).body;
  const b = D(app, 'GET', '/reports/occupancy', { propertyId: 'prop-b' }).body;
  // Occupancy is a room-nights ratio over the window; the point is that scope
  // narrows to each community: Alpha has sold nights, Bravo has none, and each
  // shows only its own single unit's available room-nights.
  assert.ok(kpi(a, /occupanc/i) > 0, 'Alpha has occupancy');
  assert.equal(kpi(b, /occupanc/i), 0, 'Bravo is vacant');
  assert.equal(kpi(a, /available/i), kpi(b, /available/i)); // one unit each
});

test('projection emits property before unit; unit carries property_id', () => {
  const app = mkApp(); setup(app);
  D(app, 'POST', '/properties', { code: 'A', name: 'Alpha' });
  D(app, 'POST', '/units', { id: 'u-1', code: 'A-1', label: 'A1', propertyId: 'prop-a' });
  const stmts = projectWorld(app.snapshotWorld('mf'));
  const order = stmts.map((s) => s.text.match(/^insert into (\w+)/)?.[1] ?? '');
  assert.ok(order.includes('property'), 'property emitted');
  assert.ok(order.indexOf('property') < order.indexOf('unit'), 'FK parent first');
  const unitStmt = stmts.find((s) => s.text.startsWith('insert into unit '))!;
  assert.ok(unitStmt.text.includes('property_id'));
  assert.equal(unitStmt.values[6], 'prop-a');
});

test('properties + unit links survive snapshot → rehydrate', () => {
  const app = mkApp(); setup(app);
  D(app, 'POST', '/legal-entities', { id: 'le-spe', role: 'spe', name: 'SPE' });
  D(app, 'POST', '/properties', { code: 'A', name: 'Alpha', entityId: 'le-spe' });
  D(app, 'POST', '/units', { id: 'u-1', code: 'A-1', label: 'A1', propertyId: 'prop-a' });
  const b = mkApp();
  b.rehydrate(app.snapshotWorld('mf'));
  const props = (D(b, 'GET', '/properties').body as { properties: Array<{ id: string; entityId?: string }> }).properties;
  assert.equal(props.length, 1);
  assert.equal(props[0]!.entityId, 'le-spe');
  const u = (D(b, 'GET', '/master-data').body as { units: Array<{ propertyId?: string }> }).units[0]!;
  assert.equal(u.propertyId, 'prop-a');
});

test('the demo seed creates properties and links its units to them', () => {
  const app = mkApp(); setup(app);
  D(app, 'POST', '/demo/seed', {});
  const props = (D(app, 'GET', '/properties').body as { properties: unknown[] }).properties;
  assert.ok(props.length >= 2);
  const md = D(app, 'GET', '/master-data').body as { units: Array<{ propertyId?: string }> };
  assert.ok(md.units.every((u) => !!u.propertyId), 'every demo unit is in a property');
});
