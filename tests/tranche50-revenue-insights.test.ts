// Tranche 50 — Revenue-management intelligence. computeRevenueInsights turns the
// demand signals + configured pricing rules into prioritized, explainable
// opportunities and risks (which lever to pull). Pure engine + the endpoint. 9 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeRevenueInsights, type RevenueSignals, type PricingRule } from '../src/revenue.ts';
import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';

const fullRule = (over: Partial<PricingRule> = {}): PricingRule => ({
  id: 'pr-1', tenantId: 't1', name: 'Beachfront', baseCents: 45000, minCents: 32000, maxCents: 120000,
  weekendFactorBps: 12500,
  occupancyTiers: [{ minOccupancyPct: 60, factorBps: 11000 }, { minOccupancyPct: 85, factorBps: 13000 }],
  losDiscounts: [{ minNights: 7, discountBps: 1000 }],
  ...over,
});
const base = (over: Partial<RevenueSignals> = {}): RevenueSignals => ({
  occupancyPct: 60, adrCents: 50000, revparCents: 30000, revenueCents: 1_000_000, unitCount: 5, rules: [fullRule()], ...over,
});

test('no pricing rule at all is the headline warning', () => {
  const ins = computeRevenueInsights(base({ rules: [] }));
  assert.equal(ins[0]!.severity, 'warning');
  assert.match(ins[0]!.title, /no dynamic pricing/i);
});

test('a rule missing occupancy tiers is flagged as an opportunity', () => {
  const ins = computeRevenueInsights(base({ rules: [fullRule({ occupancyTiers: [] })] }));
  assert.ok(ins.some((i) => /occupancy/i.test(i.title) && i.severity === 'opportunity'));
});

test('a rule with no floor is a warning (downside risk)', () => {
  const ins = computeRevenueInsights(base({ rules: [fullRule({ minCents: undefined })] }));
  assert.ok(ins.some((i) => /floor/i.test(i.title) && i.severity === 'warning'));
});

test('missing weekend uplift and LOS discount surface as info', () => {
  const ins = computeRevenueInsights(base({ rules: [fullRule({ weekendFactorBps: undefined, losDiscounts: [] })] }));
  assert.ok(ins.some((i) => /weekend/i.test(i.title)));
  assert.ok(ins.some((i) => /length-of-stay/i.test(i.title)));
});

test('strong occupancy is an opportunity to raise rates', () => {
  const ins = computeRevenueInsights(base({ occupancyPct: 92 }));
  const opp = ins.find((i) => /occupancy is strong/i.test(i.title));
  assert.ok(opp);
  assert.equal(opp!.severity, 'opportunity');
  assert.equal(opp!.metric?.value, 92);
});

test('soft occupancy is a warning to stimulate demand', () => {
  const ins = computeRevenueInsights(base({ occupancyPct: 22 }));
  const w = ins.find((i) => /occupancy is soft/i.test(i.title));
  assert.ok(w);
  assert.equal(w!.severity, 'warning');
});

test('ADR at the ceiling flags a capped rate', () => {
  const ins = computeRevenueInsights(base({ adrCents: 130000 })); // above maxCents 120000
  assert.ok(ins.some((i) => /ceiling/i.test(i.title) && i.severity === 'opportunity'));
});

test('a well-configured, healthy setup yields a positive note and no warnings', () => {
  const ins = computeRevenueInsights(base({ occupancyPct: 65 }));
  assert.ok(!ins.some((i) => i.severity === 'warning' || i.severity === 'critical'));
  assert.ok(ins.some((i) => i.severity === 'positive'));
  // Deterministic: same input, same output.
  assert.deepEqual(computeRevenueInsights(base({ occupancyPct: 65 })), ins);
});

test('GET /revenue/insights returns kpis + insights (revenue.read)', () => {
  const mgr: AuthContext = { actor: 'm', tenantId: 'jq', role: 'manager' };
  const app = new App({ authenticator: new StaticTokenAuthenticator({ mgr }), now: () => '2026-07-11T00:00:00Z' });
  app.dispatch({ method: 'POST', path: '/demo/seed', bearer: 'Bearer mgr', body: {} });
  const res = app.dispatch({ method: 'GET', path: '/revenue/insights', bearer: 'Bearer mgr', body: {} });
  assert.equal(res.status, 200);
  const body = res.body as { kpis: { occupancyPct: number }; insights: unknown[] };
  assert.ok(typeof body.kpis.occupancyPct === 'number');
  assert.ok(Array.isArray(body.insights) && body.insights.length > 0);
});
