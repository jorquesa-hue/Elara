// Tranche 58 — unit types (floorplans) + bulk unit generation: the multifamily
// model. A 200-unit building is a handful of floorplans with units hanging off
// them: CRUD + validation, the bulk generator, CSV import with a type column,
// floorplan-aware public site (grouping + detail inheritance + price fallback),
// the rent-roll floorplan column, projection SQL, and the snapshot→rehydrate
// round trip. 12 tests.

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

function setup(app: App) {
  D(app, 'PUT', '/config', { displayName: 'Greyline Residences', country: 'US' });
}

test('unit types: create, list, update; duplicate code rejected', () => {
  const app = mkApp(); setup(app);
  const res = D(app, 'POST', '/unit-types', { code: '1BR', name: 'One bedroom', bedrooms: 1, bathrooms: 1, maxGuests: 2, areaSqm: 52.5, baseRentCents: 250000 });
  assert.equal(res.status, 201);
  const t = res.body as { id: string; bedrooms: number; areaSqm: number };
  assert.equal(t.id, 'utype-1br');
  assert.equal(t.bedrooms, 1);
  assert.equal(t.areaSqm, 52.5);
  // update
  const upd = D(app, 'PUT', `/unit-types/${t.id}`, { baseRentCents: 260000, name: 'One bedroom — Garden' });
  assert.equal(upd.status, 200);
  assert.equal((upd.body as { baseRentCents: number }).baseRentCents, 260000);
  // list
  const list = D(app, 'GET', '/unit-types').body as { unitTypes: Array<{ name: string }> };
  assert.equal(list.unitTypes.length, 1);
  assert.equal(list.unitTypes[0]!.name, 'One bedroom — Garden');
  // duplicate code in the same tenant → 409 (domain error surface)
  const dup = D(app, 'POST', '/unit-types', { code: '1BR', name: 'Again' });
  assert.ok(dup.status >= 400, `expected error, got ${dup.status}`);
});

test('unit type validation: negative numbers 400, unknown typeId on a unit 404', () => {
  const app = mkApp(); setup(app);
  assert.equal(D(app, 'POST', '/unit-types', { code: 'X', name: 'X', bedrooms: -1 }).status, 400);
  const res = D(app, 'POST', '/units', { id: 'unit-a1', code: 'A1', label: 'A1', typeId: 'utype-nope' });
  assert.equal(res.status, 404);
});

test('a unit links to its floorplan and can be re-typed or unlinked', () => {
  const app = mkApp(); setup(app);
  D(app, 'POST', '/unit-types', { code: '1BR', name: 'One bedroom' });
  D(app, 'POST', '/unit-types', { code: '2BR', name: 'Two bedroom' });
  const u = D(app, 'POST', '/units', { id: 'unit-a1', code: 'A1', label: 'Apt A1', typeId: 'utype-1br' }).body as { typeId?: string };
  assert.equal(u.typeId, 'utype-1br');
  const re = D(app, 'PUT', '/units/unit-a1', { typeId: 'utype-2br' }).body as { typeId?: string };
  assert.equal(re.typeId, 'utype-2br');
  const un = D(app, 'PUT', '/units/unit-a1', { typeId: '' }).body as { typeId?: string };
  assert.equal(un.typeId, undefined);
});

test('bulk generation: 200 units in one call, idempotent on overlap, count capped', () => {
  const app = mkApp(); setup(app);
  D(app, 'POST', '/unit-types', { code: '1BR', name: 'One bedroom', baseRentCents: 250000 });
  const res = D(app, 'POST', '/units/bulk', { codePrefix: 'TWR-A-', count: 200, startNumber: 101, typeId: 'utype-1br' });
  assert.equal(res.status, 201);
  assert.equal((res.body as { created: number }).created, 200);
  // Overlapping re-run skips every existing code: first call made 101..300,
  // so 250..349 has 51 collisions (250..300) and 49 new (301..349).
  const again = D(app, 'POST', '/units/bulk', { codePrefix: 'TWR-A-', count: 100, startNumber: 250 }).body as { created: number; skipped: number };
  assert.deepEqual({ created: again.created, skipped: again.skipped }, { created: 49, skipped: 51 });
  const md = D(app, 'GET', '/master-data').body as { units: unknown[] };
  assert.equal(md.units.length, 249);
  assert.equal(D(app, 'POST', '/units/bulk', { codePrefix: 'X-', count: 501 }).status, 400);
});

test('CSV import: a floorplan column auto-creates types and links units', () => {
  const app = mkApp(); setup(app);
  const csv = 'unit,name,floorplan\nA-101,Apt 101,1BR\nA-102,Apt 102,1BR\nB-201,Apt 201,2BR\n';
  const res = D(app, 'POST', '/onboarding/commit', { target: 'units', csv });
  assert.equal(res.status, 201);
  assert.equal((res.body as { created: number }).created, 3);
  const types = (D(app, 'GET', '/unit-types').body as { unitTypes: Array<{ id: string; code: string }> }).unitTypes;
  assert.deepEqual(types.map((t) => t.id).sort(), ['utype-1br', 'utype-2br']);
  const md = D(app, 'GET', '/master-data').body as { units: Array<{ code: string; typeId?: string }> };
  assert.equal(md.units.find((u) => u.code === 'A-101')?.typeId, 'utype-1br');
  assert.equal(md.units.find((u) => u.code === 'B-201')?.typeId, 'utype-2br');
});

test('public site: floorplan sections fold published units with a min from-price', () => {
  const app = mkApp(); setup(app);
  D(app, 'POST', '/unit-types', { code: '1BR', name: 'One bedroom', bedrooms: 1, baseRentCents: 250000 });
  D(app, 'POST', '/units/bulk', { codePrefix: 'A-', count: 3, startNumber: 101, typeId: 'utype-1br' });
  const site = D(app, 'GET', '/site/mf/config', undefined, null).body as { floorplans: Array<{ id: string; unitCount: number; fromCents: number | null }> };
  assert.equal(site.floorplans.length, 1);
  assert.equal(site.floorplans[0]!.unitCount, 3);
  assert.equal(site.floorplans[0]!.fromCents, 250000); // type market rent (no agreements/rule)
});

test('public site: units inherit beds/baths from the floorplan; own details win', () => {
  const app = mkApp(); setup(app);
  D(app, 'POST', '/unit-types', { code: '2BR', name: 'Two bedroom', bedrooms: 2, bathrooms: 2, maxGuests: 4, description: 'Corner plan' });
  D(app, 'POST', '/units', { id: 'unit-b1', code: 'B1', label: 'Apt B1', typeId: 'utype-2br' });
  D(app, 'PUT', '/site-content', { content: { units: { 'unit-b1': { headline: 'Top floor', bedrooms: 3 } } } });
  const site = D(app, 'GET', '/site/mf/config', undefined, null).body as { units: Array<{ id: string; details?: { bedrooms?: number; bathrooms?: number; description?: string; headline?: string } }> };
  const u = site.units.find((x) => x.id === 'unit-b1')!;
  assert.equal(u.details?.bedrooms, 3); // authored override wins
  assert.equal(u.details?.bathrooms, 2); // inherited from the plan
  assert.equal(u.details?.description, 'Corner plan');
  assert.equal(u.details?.headline, 'Top floor');
});

test('availability quotes fall back to the floorplan market rent', () => {
  const app = mkApp(); setup(app);
  D(app, 'POST', '/unit-types', { code: '1BR', name: 'One bedroom', baseRentCents: 20000 });
  D(app, 'POST', '/units', { id: 'unit-c1', code: 'C1', label: 'Apt C1', typeId: 'utype-1br' });
  const av = D(app, 'POST', '/site/mf/availability', { from: '2026-08-01', to: '2026-08-04' }, null).body as { units: Array<{ nightlyCents: number | null; totalCents: number | null }> };
  assert.equal(av.units[0]!.nightlyCents, 20000);
  assert.equal(av.units[0]!.totalCents, 60000);
});

test('rent roll carries the floorplan column', () => {
  const app = mkApp(); setup(app);
  D(app, 'POST', '/unit-types', { code: '1BR', name: 'One bedroom' });
  D(app, 'POST', '/units', { id: 'unit-d1', code: 'D1', label: 'Apt D1', typeId: 'utype-1br' });
  const rep = (D(app, 'GET', '/reports/rent_roll').body as { report: { columns: Array<{ key: string }>; rows: Array<{ unit: string; floorplan: string }> } }).report;
  assert.ok(rep.columns.some((c) => c.key === 'floorplan'));
  assert.equal(rep.rows.find((r) => r.unit === 'Apt D1')?.floorplan, 'One bedroom');
});

test('projection emits unit_type before unit, and unit carries type_id', () => {
  const app = mkApp(); setup(app);
  D(app, 'POST', '/unit-types', { code: '1BR', name: 'One bedroom', bedrooms: 1 });
  D(app, 'POST', '/units', { id: 'unit-e1', code: 'E1', label: 'Apt E1', typeId: 'utype-1br' });
  const stmts = projectWorld(app.snapshotWorld('mf'));
  const order = stmts.map((s) => s.text.match(/^insert into (\w+)/)?.[1] ?? '');
  assert.ok(order.includes('unit_type'), 'unit_type emitted');
  assert.ok(order.indexOf('unit_type') < order.indexOf('unit'), 'FK parent first');
  const unitStmt = stmts.find((s) => s.text.startsWith('insert into unit '))!;
  assert.ok(unitStmt.text.includes('type_id'));
  assert.equal(unitStmt.values[5], 'utype-1br');
});

test('floorplans survive snapshot → rehydrate (typed units intact)', () => {
  const app = mkApp(); setup(app);
  D(app, 'POST', '/unit-types', { code: '1BR', name: 'One bedroom', bedrooms: 1, baseRentCents: 250000 });
  D(app, 'POST', '/units/bulk', { codePrefix: 'A-', count: 5, startNumber: 101, typeId: 'utype-1br' });
  const world = app.snapshotWorld('mf');
  const b = mkApp();
  b.rehydrate(world);
  const types = (D(b, 'GET', '/unit-types').body as { unitTypes: Array<{ id: string; baseRentCents?: number }> }).unitTypes;
  assert.equal(types.length, 1);
  assert.equal(types[0]!.baseRentCents, 250000);
  const site = D(b, 'GET', '/site/mf/config', undefined, null).body as { floorplans: Array<{ unitCount: number }> };
  assert.equal(site.floorplans[0]!.unitCount, 5);
});

test('config preview accepts fine-tune params alongside ?template=', () => {
  const app = mkApp(); setup(app);
  D(app, 'POST', '/units', { id: 'unit-f1', code: 'F1', label: 'Apt F1' });
  const th = (D(app, 'GET', '/site/mf/config', { template: 'minima', radius: 'round', cards: 'wide', font: 'junk' }, null).body as { theme: { id: string; radiusPx: number; cards: string } }).theme;
  assert.equal(th.id, 'minima');
  assert.equal(th.radiusPx, 22); // round
  assert.equal(th.cards, 'wide');
});
