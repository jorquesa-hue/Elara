// Tranche 97 — "trust the numbers" from the front-end audit. The dashboards must
// report ONE occupancy: physical occupancy (occupied ÷ rentable units), the same
// figure the rent roll uses. The nightly hotel metrics (ADR/RevPAR/occupancy)
// are quarantined to the Revenue cockpit and computed over NIGHTLY inventory
// only, so a lease-heavy portfolio no longer produces a cents-level ADR.

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
  D(app, 'POST', '/demo/seed', { variant: 'portfolio', at: NOW });
  return app;
}

test('reporting summary reports physical occupancy that matches the rent roll', () => {
  const app = seeded();
  const occ = (D(app, 'GET', '/reporting/summary').body as { occupancy: { physicalOccupancyPct: number; occupiedUnits: number; rentableUnits: number } }).occupancy;
  assert.ok(occ.physicalOccupancyPct >= 80 && occ.physicalOccupancyPct < 100, `physical occ ${occ.physicalOccupancyPct}%`);
  assert.ok(occ.occupiedUnits > 0 && occ.rentableUnits >= occ.occupiedUnits);
  // Same definition as the rent roll KPI.
  const rr = (D(app, 'GET', '/reports/rent_roll', { from: '1970-01-01', to: '2026-07-25' }).body as { report: { kpis: Array<{ label: string; value: number }> } }).report.kpis;
  const rrOcc = rr.find((k) => /occup/i.test(k.label) && !/\//.test(k.label))!;
  assert.equal(occ.physicalOccupancyPct, rrOcc.value, 'dashboard occupancy == rent-roll occupancy');
});

test('the attention-feed occupancy insight matches the dashboard occupancy (one number)', () => {
  const app = seeded();
  const dash = (D(app, 'GET', '/reporting/summary').body as { occupancy: { physicalOccupancyPct: number } }).occupancy.physicalOccupancyPct;
  const insights = (D(app, 'GET', '/reports/insights').body as { insights: Array<{ code: string; metric?: { value: number } }> }).insights;
  const occ = insights.find((i) => i.code === 'occ_strong' || i.code === 'occ_low');
  assert.ok(occ, 'an occupancy insight fired');
  assert.equal(occ!.metric!.value, dash, 'insight occupancy == dashboard occupancy — no contradiction');
});

test('nightly hotel metrics only count nightly inventory — no cents-level ADR from leases', () => {
  const app = seeded();
  const s = D(app, 'GET', '/revenue/summary').body as { adrCents: number; soldRoomNights: number; nightlyStays: number };
  // The structural fix: ADR = nightly revenue ÷ NIGHTLY nights sold. Folding
  // 200k+ annual-lease nights into the denominator drove ADR to $0.38 and the
  // page called it "healthy". Sold-nights now count nightly stays only, so the
  // count is on the order of hundreds — not hundreds of thousands.
  assert.ok(s.nightlyStays > 0, 'portfolio has some nightly stays');
  assert.ok(s.adrCents > 0, `ADR is a positive nightly figure, got ${s.adrCents}`);
  assert.ok(s.soldRoomNights > 0 && s.soldRoomNights < 5000, `sold-nights is the nightly slice (${s.soldRoomNights}), not 200k+ lease nights`);
});

test('a pure-lease scope yields zero nightly metrics (portal hides the cards)', () => {
  const app = new App({ authenticator: new StaticTokenAuthenticator({ own }), units: [], now: () => NOW });
  D(app, 'PUT', '/config', { displayName: 'M', country: 'US' });
  // Book a single annual lease, nothing nightly.
  D(app, 'POST', '/units', { code: 'A1', label: 'Apt 1' });
  D(app, 'POST', '/guests', { code: 'G1', fullName: 'Lease Only' });
  D(app, 'POST', '/agreements', { id: 'ag1', guestId: 'guest-G1', unitId: 'unit-A1', kind: 'lease', start: '2026-01-01', end: '2027-01-01', rateCents: 200000 });
  const s = D(app, 'GET', '/revenue/summary').body as { adrCents: number; nightlyStays: number; occupancyPct: number };
  assert.equal(s.nightlyStays, 0);
  assert.equal(s.adrCents, 0);
  assert.equal(s.occupancyPct, 0);
});
