// Tranche 105 — per-week rent quoting. UK and Australian student housing sells
// on a WEEKLY number; most multifamily quotes monthly; short stay nightly. Elara
// carries the period WITH the figure, so a price is always labelled in the unit
// the operator typed it in — it never converts weekly into monthly or back. 10 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { siteListing, type BookingSiteInput } from '../src/booking-site.ts';
import { sanitizeSiteContent, RENT_PERIODS, RENT_PERIOD_LABEL, isRentPeriod } from '../src/site-content.ts';
import { bookingSiteHtml } from '../src/api/booking-site.ts';
import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';

const SITE = bookingSiteHtml();
const NOW = '2026-07-25T00:00:00Z';

function studentApp() {
  const mgr: AuthContext = { actor: 'm', tenantId: 'jq', role: 'owner' };
  const app = new App({ authenticator: new StaticTokenAuthenticator({ mgr }), now: () => NOW });
  const D = (method: string, path: string, body?: Record<string, unknown>) =>
    app.dispatch({ method, path, bearer: 'Bearer mgr', body: body ?? {} });
  D('PUT', '/config', { displayName: 'Northgate Student Living', country: 'GB', businessStructure: 'student_housing' });
  D('POST', '/unit-types', { code: 'ENSUITE', name: 'Classic En-suite', bedrooms: 1, bathrooms: 1, areaSqm: 14, baseRentCents: 17_900 });
  D('POST', '/units', { id: 'unit-A101', code: 'A101', label: 'Block A — Room 101', typeId: 'utype-ensuite' });
  return { app, D };
}
const listing = (app: App) => app.dispatch({ method: 'GET', path: '/site/jq/config', body: {} }).body as {
  content: { rentPeriod?: string };
  units: Array<{ fromCents: number | null; pricePeriod?: string }>;
  floorplans: Array<{ fromCents: number | null; rentPeriod?: string }>;
};

const base = (over: Partial<BookingSiteInput> = {}): BookingSiteInput => ({
  tenantId: 't', displayName: 'T', currency: 'GBP',
  units: [{ id: 'u1', label: 'Room 1', active: true, typeId: 'ty1' }],
  holds: [], agreements: [],
  unitTypes: [{ id: 'ty1', code: 'ENS', name: 'En-suite', baseRentCents: 17_900 }],
  ...over,
});

test('the three periods are a closed set with honest labels', () => {
  assert.deepEqual([...RENT_PERIODS], ['night', 'week', 'month']);
  assert.equal(RENT_PERIOD_LABEL.week, 'per week');
  assert.equal(RENT_PERIOD_LABEL.month, '/ month');
  assert.equal(RENT_PERIOD_LABEL.night, '/ night');
  for (const p of RENT_PERIODS) assert.ok(isRentPeriod(p));
  for (const junk of ['fortnight', 'weekly', '', 'WEEK', 7, null, undefined]) assert.equal(isRentPeriod(junk), false, String(junk));
});

test('an explicit weekly site quotes every price per week', () => {
  const l = siteListing(base({ content: { rentPeriod: 'week' } }));
  assert.equal(l.units[0]!.pricePeriod, 'week');
  assert.equal(l.floorplans[0]!.rentPeriod, 'week');
  // The FIGURE is untouched — Elara labels what the operator typed.
  assert.equal(l.units[0]!.fromCents, 17_900);
  assert.equal(l.floorplans[0]!.fromCents, 17_900);
});

test('no conversion happens between periods — the number never moves', () => {
  const weekly = siteListing(base({ content: { rentPeriod: 'week' } }));
  const monthly = siteListing(base({ content: { rentPeriod: 'month' } }));
  assert.equal(weekly.units[0]!.fromCents, monthly.units[0]!.fromCents,
    'switching the period must not silently multiply the rent');
});

test('without an explicit period the label follows the SOURCE of the figure', () => {
  // A floorplan market rent is a monthly asking rent by convention…
  const fromPlan = siteListing(base());
  assert.equal(fromPlan.units[0]!.pricePeriod, 'month');
  // …a dynamic pricing rule is nightly…
  const fromRule = siteListing(base({ unitTypes: [{ id: 'ty1', code: 'ENS', name: 'En-suite' }], rule: { id: 'r', tenantId: 't', name: 'r', baseCents: 12_000 } }));
  assert.equal(fromRule.units[0]!.pricePeriod, 'night');
  // …and a live agreement rate carries its own period.
  const fromAgreement = siteListing(base({ agreements: [{ unitId: 'u1', rateCents: 22_000, start: '2026-01-01', period: 'week' }] }));
  assert.equal(fromAgreement.units[0]!.pricePeriod, 'week');
  assert.equal(fromAgreement.units[0]!.fromCents, 22_000);
});

test('a declared site period overrides the inferred one', () => {
  // The operator says "we quote weekly", so a floorplan rent is labelled weekly
  // rather than falling back to the monthly convention.
  const l = siteListing(base({ content: { rentPeriod: 'week' } }));
  assert.equal(l.units[0]!.pricePeriod, 'week');
  const nightly = siteListing(base({ content: { rentPeriod: 'night' } }));
  assert.equal(nightly.units[0]!.pricePeriod, 'night');
});

test('a unit with no price at all carries no period (contact for rates)', () => {
  const l = siteListing(base({ unitTypes: [{ id: 'ty1', code: 'ENS', name: 'En-suite' }], content: { rentPeriod: 'week' } }));
  assert.equal(l.units[0]!.fromCents, null);
  assert.equal(l.units[0]!.pricePeriod, undefined, 'no figure, no label');
});

test('sanitize keeps a valid period and drops anything else', () => {
  assert.equal(sanitizeSiteContent({ rentPeriod: 'week' }).rentPeriod, 'week');
  assert.equal(sanitizeSiteContent({ rentPeriod: 'month' }).rentPeriod, 'month');
  for (const junk of ['fortnight', 'per week', 'WEEK', 4, {}, null]) {
    assert.equal(sanitizeSiteContent({ rentPeriod: junk }).rentPeriod, undefined, String(junk));
  }
});

test('an operator can set weekly quoting through the API end to end', () => {
  const { app, D } = studentApp();
  assert.equal(listing(app).units[0]!.pricePeriod, 'month', 'default before the operator says otherwise');
  assert.equal(D('PUT', '/site-content', { content: { rentPeriod: 'week' } }).status, 200);
  const l = listing(app);
  assert.equal(l.content.rentPeriod, 'week');
  assert.equal(l.units[0]!.pricePeriod, 'week');
  assert.equal(l.units[0]!.fromCents, 17_900, '£179.00 per week — the figure entered');
  assert.equal(l.floorplans[0]!.rentPeriod, 'week');
});

test('the weekly setting survives snapshot → rehydrate', () => {
  const { app, D } = studentApp();
  D('PUT', '/site-content', { content: { rentPeriod: 'week' } });
  const world = app.snapshotWorld('jq');
  const mgr: AuthContext = { actor: 'm', tenantId: 'jq', role: 'owner' };
  const b = new App({ authenticator: new StaticTokenAuthenticator({ mgr }), now: () => NOW });
  b.rehydrate(world);
  // It rides tenant.site_content, which already persists — no migration needed.
  assert.equal(listing(b).content.rentPeriod, 'week');
});

test('the public site prints the period instead of a hardcoded "/ night"', () => {
  assert.ok(SITE.includes('var PERIOD_LABEL={ night:"/ night", week:"per week", month:"/ month" };'));
  assert.ok(SITE.includes('function fromSuffix(u)'), 'unit + community cards');
  assert.ok(SITE.includes('function planSuffix(f)'), 'floorplan sections');
  assert.ok(!SITE.includes('from / night'), 'no hardcoded nightly "from" label survives');
  // "From" reads before the amount: "From £179.00 per week", not "£179.00 from per week".
  assert.ok(SITE.includes('function fromPrefix(){ return el("small",{},["From "]); }'));
  // A DATED quote stays nightly — that is genuinely what the pricing engine computed.
  assert.ok(SITE.includes('" / night · "'), 'dated availability quotes stay nightly');
});
