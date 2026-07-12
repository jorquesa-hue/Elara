// Tranche 53 — integrated booking website. The pure engine (per-unit "from"
// pricing, live availability + dynamic-pricing quotes, held units excluded) plus
// the PUBLIC (pre-auth) /site/:tenant endpoints: config, availability, and a
// booking inquiry that drops a lead into the operator pipeline. 12 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { siteListing, checkAvailability, isValidDate, type BookingSiteInput } from '../src/booking-site.ts';
import type { PricingRule } from '../src/revenue.ts';
import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';

const rule: PricingRule = {
  id: 'r1', tenantId: 'jq', name: 'Beach', baseCents: 40000,
  weekendFactorBps: 13000, // +30% Fri/Sat check-in
  occupancyTiers: [], losDiscounts: [{ minNights: 7, discountBps: 1000 }],
};
function input(over: Partial<BookingSiteInput> = {}): BookingSiteInput {
  return {
    tenantId: 'jq', displayName: 'Ilhabela Stays', currency: 'BRL',
    units: [
      { id: 'u1', label: 'Apt 101', active: true },
      { id: 'u2', label: 'Apt 102', active: true },
      { id: 'u3', label: 'Apt 103 (reforma)', active: false },
    ],
    holds: [{ unitId: 'u2', start: '2026-08-01', end: '2026-08-10', status: 'active' }],
    agreements: [
      { unitId: 'u1', rateCents: 55000, start: '2026-06-01' },
      { unitId: 'u1', rateCents: 50000, start: '2026-01-01' }, // older — ignored
    ],
    rule,
    ...over,
  };
}

test('isValidDate accepts real ISO dates and rejects junk', () => {
  assert.ok(isValidDate('2026-08-05'));
  assert.ok(!isValidDate('2026-02-30')); // not a real day
  assert.ok(!isValidDate('08/05/2026'));
  assert.ok(!isValidDate(20260805 as unknown));
});

test('listing shows only active units with a "from" price (latest agreement rate)', () => {
  const l = siteListing(input());
  assert.equal(l.units.length, 2); // inactive u3 excluded
  const u1 = l.units.find((u) => u.id === 'u1')!;
  assert.equal(u1.fromCents, 55000); // most recent agreement rate, not the older 50000
});

test('a unit with no agreement falls back to the rule base for its "from" price', () => {
  const l = siteListing(input());
  assert.equal(l.units.find((u) => u.id === 'u2')!.fromCents, 40000); // rule.baseCents
});

test('no agreement and no rule → from price is null (contact for rates)', () => {
  const l = siteListing({ ...input({ rule: undefined }), agreements: [] });
  assert.equal(l.units.find((u) => u.id === 'u2')!.fromCents, null);
});

test('availability excludes a unit held for overlapping dates', () => {
  const a = checkAvailability(input(), '2026-08-05', '2026-08-08'); // overlaps u2's hold
  assert.equal(a.find((u) => u.unitId === 'u2')!.available, false);
  assert.equal(a.find((u) => u.unitId === 'u1')!.available, true);
});

test('availability includes a unit whose hold does not overlap the window', () => {
  const a = checkAvailability(input(), '2026-09-01', '2026-09-05'); // after u2's hold
  assert.equal(a.find((u) => u.unitId === 'u2')!.available, true);
});

test('available units carry a dynamic-pricing quote (weekend uplift applied)', () => {
  // 2026-08-07 is a Friday → weekend uplift on u1 (base 55000 → +30% = 71500).
  const a = checkAvailability(input(), '2026-08-07', '2026-08-10');
  const u1 = a.find((u) => u.unitId === 'u1')!;
  assert.equal(u1.nights, 3);
  assert.equal(u1.nightlyCents, 71500);
  assert.equal(u1.totalCents, 71500 * 3);
  assert.ok(u1.factors && u1.factors.some((f) => f.name === 'weekend'));
});

test('reversed or invalid dates throw', () => {
  assert.throws(() => checkAvailability(input(), '2026-08-10', '2026-08-05'));
  assert.throws(() => checkAvailability(input(), 'nope', '2026-08-05'));
});

// --- public endpoints (no bearer) -----------------------------------------
function seededApp() {
  const mgr: AuthContext = { actor: 'm', tenantId: 'jq', role: 'manager' };
  const app = new App({ authenticator: new StaticTokenAuthenticator({ mgr }), now: () => '2026-07-11T00:00:00Z' });
  app.dispatch({ method: 'POST', path: '/demo/seed', bearer: 'Bearer mgr', body: {} });
  return app;
}

test('GET /site/:tenant/config is public (no bearer) and lists bookable units', () => {
  const app = seededApp();
  const res = app.dispatch({ method: 'GET', path: '/site/jq/config', body: {} }); // NO bearer
  assert.equal(res.status, 200);
  const body = res.body as { displayName: string; units: unknown[] };
  assert.ok(body.units.length >= 8);
});

test('an unknown tenant site returns 404, not a 401', () => {
  const app = seededApp();
  const res = app.dispatch({ method: 'GET', path: '/site/does-not-exist/config', body: {} });
  assert.equal(res.status, 404);
});

test('POST /site/:tenant/availability is public and returns quotes', () => {
  const app = seededApp();
  const res = app.dispatch({ method: 'POST', path: '/site/jq/availability', body: { from: '2026-09-01', to: '2026-09-05' } });
  assert.equal(res.status, 200);
  const body = res.body as { units: Array<{ available: boolean; nightlyCents: number | null }> };
  assert.ok(body.units.some((u) => u.available && u.nightlyCents != null));
});

test('POST /site/:tenant/inquire creates a website lead in the pipeline', () => {
  const app = seededApp();
  const before = (app.dispatch({ method: 'GET', path: '/leads', bearer: 'Bearer mgr', body: {} }).body as { leads: unknown[] }).leads.length;
  const res = app.dispatch({ method: 'POST', path: '/site/jq/inquire', body: { unitId: 'demo-unit-ILH-101', from: '2026-09-01', to: '2026-09-05', name: 'Guest Q', email: 'q@example.com' } });
  assert.equal(res.status, 201);
  assert.equal((res.body as { ok: boolean }).ok, true);
  const leads = app.dispatch({ method: 'GET', path: '/leads', bearer: 'Bearer mgr', body: {} }).body as { leads: Array<{ source: string; name: string }> };
  assert.equal(leads.leads.length, before + 1);
  const web = leads.leads.find((l) => /Guest Q/.test(l.name));
  assert.ok(web && web.source === 'website');
  // Missing name/email → 400 (not a silent lead).
  assert.equal(app.dispatch({ method: 'POST', path: '/site/jq/inquire', body: { unitId: 'demo-unit-ILH-101', from: '2026-09-01', to: '2026-09-05' } }).status, 400);
});
