// Tranche 93 — the institutional 'portfolio' demo variant. A big multi-portfolio
// operator (Meridian Residential): three communities of ~200+ homes each — a
// long-lease high-rise, a multifamily building that also runs short stay, and a
// student-housing building — so the demo reads at institutional scale. It must
// seed in one balanced pass, populate EVERY module, and survive rehydrate.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';

const NOW = '2026-07-24T00:00:00Z';
const own: AuthContext = { actor: 'own', tenantId: 't', role: 'owner' };
const D = (app: App, method: string, path: string, body?: Record<string, unknown>) =>
  app.dispatch({ method, path, bearer: 'Bearer own', body: body ?? {} });

function seeded() {
  const app = new App({ authenticator: new StaticTokenAuthenticator({ own }), units: [], now: () => NOW });
  D(app, 'PUT', '/config', { displayName: 'Meridian', country: 'US' });
  const res = D(app, 'POST', '/demo/seed', { variant: 'portfolio', at: NOW });
  assert.equal(res.status, 201, `seed status ${res.status}`);
  return { app, counts: (res.body as { counts: Record<string, number> }).counts };
}

const firstArray = (body: unknown): unknown[] =>
  (Object.values(body as Record<string, unknown>).find(Array.isArray) as unknown[]) ?? [];

test('the portfolio seed is institutional scale in one balanced pass', () => {
  const { app, counts } = seeded();
  assert.ok((counts.units ?? 0) >= 600, `600+ units, got ${counts.units}`);
  assert.ok((counts.agreements ?? 0) >= 500, `500+ leases, got ${counts.agreements}`);
  assert.ok((counts.parties ?? 0) >= 500, `a resident per lease, got ${counts.parties}`);
  assert.equal((app.dispatch({ method: 'GET', path: '/properties', bearer: 'Bearer own', body: {} }).body as { properties: unknown[] }).properties.length, 3);
  const tb = D(app, 'GET', '/ledger/trial-balance').body as { balanced: boolean; net: number };
  assert.equal(tb.balanced, true);
  assert.equal(tb.net, 0);
  // A believable, not-100% occupancy so vacancy/make-ready have data too.
  const occ = ((D(app, 'GET', '/reports/rent_roll', { from: '1970-01-01', to: '2026-07-25' }).body as { report: { kpis: Array<{ label: string; value: number }> } }).report.kpis).find((k) => /occup/i.test(k.label))!;
  assert.ok(occ.value >= 80 && occ.value < 100, `occupancy ${occ.value}%`);
});

test('every specialty module is populated on the portfolio seed', () => {
  const { app } = seeded();
  const views: Array<[string, number]> = [
    ['/unit-types', 6], ['/tours', 3], ['/applications', 3], ['/insurance-policies', 5],
    ['/utility-bills', 3], ['/parcels', 5], ['/waitlist', 3], ['/distributions', 1],
    ['/contributions', 1], ['/prospects', 2], ['/reservations', 2], ['/threads', 2],
    ['/bank-transactions', 3], ['/purchase-orders', 2], ['/budgets', 1], ['/turns', 2],
    ['/pm-schedules', 3], ['/signature-envelopes', 1], ['/notifications', 3], ['/spaces', 3],
    ['/property-budgets', 3],
  ];
  for (const [path, min] of views) {
    const r = D(app, 'GET', path);
    assert.equal(r.status, 200, `${path} → ${r.status}`);
    assert.ok(firstArray(r.body).length >= min, `${path} has >= ${min}`);
  }
  // Owner statement rolls up per community (one row per property).
  const owner = (D(app, 'GET', '/reports/owner_statement', { from: '1970-01-01', to: '2026-07-25' }).body as { report: { rows: unknown[] } }).report;
  assert.ok(owner.rows.length >= 3, 'owner statement covers the communities');
});

test('force re-seed is idempotent — tops up missing rows without duplicating', () => {
  const { app, counts } = seeded();
  // A plain re-seed is a no-op (the marker unit exists).
  const noop = D(app, 'POST', '/demo/seed', { variant: 'portfolio', at: NOW }).body as { seeded: boolean };
  assert.equal(noop.seeded, false);
  // A forced re-seed re-runs every create, but each duplicate is skipped, so the
  // world is unchanged: same unit/agreement/party counts, still balanced.
  const forced = D(app, 'POST', '/demo/seed', { variant: 'portfolio', at: NOW, force: true }).body as { seeded: boolean; counts: Record<string, number> };
  assert.equal(forced.seeded, true);
  const rr = (D(app, 'GET', '/reports/rent_roll', { from: '1970-01-01', to: '2026-07-25' }).body as { report: { rows: unknown[] } }).report;
  assert.equal(rr.rows.length, counts.units, 'no duplicate units after a forced re-seed');
  assert.equal((D(app, 'GET', '/agreements').body as { agreements: unknown[] }).agreements.length, counts.agreements, 'no duplicate leases');
  assert.equal((D(app, 'GET', '/ledger/trial-balance').body as { balanced: boolean }).balanced, true, 'still balanced');
});

test('force re-seed fills leases dropped by a partial persist', () => {
  // Simulate a half-persisted tenant: the master data (units/guests/parties/…)
  // loaded, but everything that posts to the ledger (leases, invoices, bills)
  // was dropped by a partial flush. Keep ONLY the master-data slice, empty every
  // other array. A forced re-seed must fill the missing leases back in without
  // duplicate-keying the units, and land balanced.
  const { app } = seeded();
  const full = app.snapshotWorld('t') as unknown as Record<string, unknown>;
  const keep = new Set(['tenants', 'units', 'guests', 'parties', 'spaces', 'properties', 'legalEntities', 'unitTypes', 'pricingRules', 'bankAccounts', 'customRoles', 'users']);
  const partial: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(full)) partial[k] = Array.isArray(v) && !keep.has(k) ? [] : v;
  const b = new App({ authenticator: new StaticTokenAuthenticator({ own }), units: [], now: () => NOW });
  D(b, 'PUT', '/config', { displayName: 'Meridian', country: 'US' });
  b.rehydrate(partial as never);
  assert.equal((D(b, 'GET', '/agreements').body as { agreements: unknown[] }).agreements.length, 0, 'leases start missing');
  const unitsBefore = (D(b, 'GET', '/reports/rent_roll', { from: '1970-01-01', to: '2026-07-25' }).body as { report: { rows: unknown[] } }).report.rows.length;
  assert.ok(unitsBefore >= 600, 'units survived the partial load');
  const forced = D(b, 'POST', '/demo/seed', { variant: 'portfolio', at: NOW, force: true }).body as { seeded: boolean };
  assert.equal(forced.seeded, true);
  assert.ok((D(b, 'GET', '/agreements').body as { agreements: unknown[] }).agreements.length >= 500, 'leases were topped up');
  const unitsAfter = (D(b, 'GET', '/reports/rent_roll', { from: '1970-01-01', to: '2026-07-25' }).body as { report: { rows: unknown[] } }).report.rows.length;
  assert.equal(unitsAfter, unitsBefore, 'no duplicate units');
  assert.equal((D(b, 'GET', '/ledger/trial-balance').body as { balanced: boolean }).balanced, true);
});

test('the institutional world survives snapshot -> rehydrate', () => {
  const { app } = seeded();
  const world = app.snapshotWorld('t');
  const b = new App({ authenticator: new StaticTokenAuthenticator({ own }), units: [], now: () => NOW });
  b.rehydrate(world);
  assert.ok((firstArray(D(b, 'GET', '/properties').body)).length === 3);
  const rr = (D(b, 'GET', '/reports/rent_roll', { from: '1970-01-01', to: '2026-07-25' }).body as { report: { rows: unknown[] } }).report;
  assert.ok(rr.rows.length >= 600, 'all units reload');
  assert.equal((D(b, 'GET', '/ledger/trial-balance').body as { balanced: boolean }).balanced, true);
});
