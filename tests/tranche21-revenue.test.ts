// Tranche 21 — revenue management & dynamic pricing (#1). A pricing rule turns a
// base rate into a nightly quote through explainable, multiplicative factors
// (occupancy, weekend, lead-time, length-of-stay, season) then clamps to a
// floor/ceiling. Pure & deterministic — the "AI/demand" seam is the occupancy
// signal fed in. Plus the headline KPIs (occupancy/ADR/RevPAR). 12 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeQuote, revenueKpis, RevenueManagement, RevenueError, type PricingRule } from '../src/revenue.ts';
import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';
import { ACCOUNTS } from '../src/billing.ts';

const T = '2026-07-01T00:00:00Z';
const bearer = (t: string) => `Bearer ${t}`;
const D = (app: App, method: string, path: string, token: string, body?: Record<string, unknown>) =>
  app.dispatch({ method, path, bearer: bearer(token), body });

const baseRule: PricingRule = {
  id: 'pr-1', tenantId: 't1', name: 'Studio', baseCents: 20000,
  minCents: 15000, maxCents: 60000,
  weekendFactorBps: 12000, // +20% Fri/Sat
  occupancyTiers: [
    { minOccupancyPct: 50, factorBps: 11000 }, // +10%
    { minOccupancyPct: 80, factorBps: 13000 }, // +30%
  ],
  leadTimeTiers: [
    { maxDaysOut: 3, factorBps: 12000 }, // last-minute +20%
    { maxDaysOut: 30, factorBps: 10500 }, // +5%
  ],
  losDiscounts: [
    { minNights: 7, discountBps: 1000 }, // -10% weekly
    { minNights: 28, discountBps: 2000 }, // -20% monthly
  ],
  seasons: [{ start: '2026-12-20', end: '2027-01-05', factorBps: 15000 }], // NYE +50%
};

// ---- pure engine ---------------------------------------------------------

test('base quote with no active factors returns the base rate', () => {
  // A Wednesday (2026-07-01 is a Wednesday), no occupancy, no asOf, 1 night.
  const q = computeQuote({ ...baseRule, seasons: [] }, { checkIn: '2026-07-01', nights: 1 });
  assert.equal(q.nightlyCents, 20000);
  assert.equal(q.totalCents, 20000);
  assert.equal(q.factors.length, 0);
});

test('occupancy: the highest matching tier wins (demand uplift)', () => {
  const q = computeQuote(baseRule, { checkIn: '2026-07-01', nights: 1, occupancyPct: 85 });
  // 20000 * 1.30 = 26000
  assert.equal(q.nightlyCents, 26000);
  assert.equal(q.factors[0]!.name, 'occupancy≥80%');
});

test('weekend uplift applies on Fri/Sat check-in', () => {
  // 2026-07-03 is a Friday.
  const q = computeQuote({ ...baseRule, occupancyTiers: [], seasons: [] }, { checkIn: '2026-07-03', nights: 1 });
  assert.equal(q.nightlyCents, 24000); // 20000 * 1.20
  assert.equal(q.factors.some((f) => f.name === 'weekend'), true);
});

test('lead-time: the tightest matching tier (fewest days out) wins', () => {
  const q = computeQuote({ ...baseRule, occupancyTiers: [], seasons: [] }, { checkIn: '2026-07-02', nights: 1, asOf: '2026-07-01' });
  // 1 day out → last-minute +20%
  assert.equal(q.nightlyCents, 24000);
  assert.equal(q.factors.some((f) => f.name === 'lead≤3d'), true);
});

test('length-of-stay discount: the highest matching minNights wins', () => {
  const q = computeQuote({ ...baseRule, occupancyTiers: [], seasons: [], weekendFactorBps: undefined }, { checkIn: '2026-07-01', nights: 30 });
  // 30 nights → monthly -20% → 16000 nightly
  assert.equal(q.nightlyCents, 16000);
  assert.equal(q.totalCents, 16000 * 30);
  assert.equal(q.factors.some((f) => f.name === 'los≥28n'), true);
});

test('season window multiplies inside [start, end)', () => {
  const q = computeQuote({ ...baseRule, occupancyTiers: [], weekendFactorBps: undefined }, { checkIn: '2026-12-25', nights: 1 });
  // 20000 * 1.50 = 30000
  assert.equal(q.nightlyCents, 30000);
  assert.equal(q.factors.some((f) => f.name.startsWith('season')), true);
});

test('clamp: the ceiling caps a stacked-up rate', () => {
  // Weekend (Fri) + 80% occupancy + season would exceed maxCents 60000.
  const q = computeQuote(baseRule, { checkIn: '2026-12-25', nights: 1, occupancyPct: 85 });
  // 2026-12-25 is a Friday: 20000*1.3*1.2*1.5 = 46800 (< 60000, no clamp) — bump base to force clamp.
  const hot = computeQuote({ ...baseRule, baseCents: 40000 }, { checkIn: '2026-12-25', nights: 1, occupancyPct: 85 });
  assert.ok(q.nightlyCents <= 60000);
  assert.equal(hot.nightlyCents, 60000);
  assert.equal(hot.factors.some((f) => f.name === 'ceiling'), true);
});

test('invalid inputs throw RevenueError', () => {
  assert.throws(() => computeQuote({ ...baseRule, baseCents: 0 }, { checkIn: '2026-07-01', nights: 1 }), RevenueError);
  assert.throws(() => computeQuote(baseRule, { checkIn: '2026-07-01', nights: 0 }), RevenueError);
});

test('revenueKpis computes occupancy / ADR / RevPAR', () => {
  const k = revenueKpis({ availableRoomNights: 100, soldRoomNights: 75, revenueCents: 1_500_000 });
  assert.equal(k.occupancyPct, 75);
  assert.equal(k.adrCents, 20000); // 1_500_000 / 75
  assert.equal(k.revparCents, 15000); // 1_500_000 / 100
  const empty = revenueKpis({ availableRoomNights: 0, soldRoomNights: 0, revenueCents: 0 });
  assert.equal(empty.occupancyPct, 0);
  assert.equal(empty.adrCents, 0);
});

test('RevenueManagement is tenant-scoped', () => {
  const rm = new RevenueManagement();
  rm.setRule(baseRule);
  assert.equal(rm.getRule('t1', 'pr-1')!.baseCents, 20000);
  assert.equal(rm.getRule('t2', 'pr-1'), null); // not visible to another tenant
  assert.equal(rm.listRules('t2').length, 0);
});

// ---- through the Public API ----------------------------------------------

function makeApp() {
  const owner: AuthContext = { actor: 'ana', tenantId: 't1', role: 'owner' };
  const reader: AuthContext = { actor: 'aud', tenantId: 't1', role: 'read_only' };
  const desk: AuthContext = { actor: 'desk', tenantId: 't1', role: 'front_desk' };
  const auth = new StaticTokenAuthenticator({ own: owner, ro: reader, desk });
  return new App({ authenticator: auth, units: [{ id: 'u-1', tenantId: 't1' }, { id: 'u-2', tenantId: 't1' }], now: () => T });
}

test('API: create a pricing rule, list it, and quote it', () => {
  const app = makeApp();
  assert.equal(D(app, 'POST', '/pricing-rules', 'own', { ...baseRule } as Record<string, unknown>).status, 201);
  const list = D(app, 'GET', '/pricing-rules', 'own').body as { rules: PricingRule[] };
  assert.equal(list.rules.length, 1);
  const q = D(app, 'POST', '/pricing/quote', 'own', { ruleId: 'pr-1', checkIn: '2026-07-01', nights: 1, occupancyPct: 85 });
  assert.equal(q.status, 200);
  assert.equal((q.body as { nightlyCents: number }).nightlyCents, 26000);
  // unknown rule → 404
  assert.equal(D(app, 'POST', '/pricing/quote', 'own', { ruleId: 'nope', checkIn: '2026-07-01', nights: 1 }).status, 404);
});

test('API: RBAC — read_only can quote but not create; summary folds tenant state', () => {
  const app = makeApp();
  D(app, 'POST', '/pricing-rules', 'own', { ...baseRule } as Record<string, unknown>);
  // read_only: read yes, manage no.
  assert.equal(D(app, 'GET', '/pricing-rules', 'ro').status, 200);
  assert.equal(D(app, 'POST', '/pricing-rules', 'ro', { ...baseRule, id: 'pr-2' }).status, 403);
  // front_desk has revenue.read (OPS) but not revenue.manage.
  assert.equal(D(app, 'POST', '/pricing-rules', 'desk', { ...baseRule, id: 'pr-3' }).status, 403);

  // Book a 9-night stay and collect cash → the KPIs move.
  D(app, 'POST', '/agreements', 'own', { id: 'ag-1', guestId: 'g-1', unitId: 'u-1', kind: 'nightly', start: '2026-07-01', end: '2026-07-10', rateCents: 20000 });
  D(app, 'POST', '/agreements/ag-1/activate', 'own', {});
  D(app, 'POST', '/invoices', 'own', { id: 'inv-1', agreementId: 'ag-1', dueAt: '2026-07-09', lines: [{ description: '9 nights', account: ACCOUNTS.roomRevenue, amountCents: 180000 }] });
  D(app, 'POST', '/payments', 'own', { id: 'pay-1', invoiceId: 'inv-1', amountCents: 180000, method: 'pix' });

  const s = D(app, 'GET', '/revenue/summary', 'ro').body as { soldRoomNights: number; availableRoomNights: number; revenueCents: number; adrCents: number };
  assert.equal(s.soldRoomNights, 9);
  assert.equal(s.availableRoomNights, 2 * 9); // 2 units × 9-night window
  assert.equal(s.revenueCents, 180000);
  assert.equal(s.adrCents, 20000); // 180000 / 9
});
