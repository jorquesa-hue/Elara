// Tranche 95 — Insight i18n. The two server-side insight generators
// (computeRevenueInsights + computeInsights) now attach stable i18n keys
// (titleKey/messageKey[/actionKey]) + params alongside the English strings, so
// the operator portal can render the finding in the tenant's locale. Guarantees:
//  (a) each generator emits titleKey/messageKey + a params object on every insight;
//  (b) interpolating a non-English (fr) template with the insight's params
//      re-inserts the dynamic value (no locale drops it);
//  (c) every revenue-insight key added here exists in ALL SIX locales (parity),
//      and the plain English title/detail still match the template output.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeRevenueInsights, type RevenueSignals, type PricingRule } from '../src/revenue.ts';
import { computeInsights, type ReportingInput } from '../src/reporting.ts';
import { mergedCatalog, interpolate } from '../src/i18n.ts';

const fullRule = (over: Partial<PricingRule> = {}): PricingRule => ({
  id: 'pr-1', tenantId: 't1', name: 'Beachfront', baseCents: 45000, minCents: 32000, maxCents: 120000,
  weekendFactorBps: 12500,
  occupancyTiers: [{ minOccupancyPct: 60, factorBps: 11000 }, { minOccupancyPct: 85, factorBps: 13000 }],
  losDiscounts: [{ minNights: 7, discountBps: 1000 }],
  ...over,
});
const sig = (over: Partial<RevenueSignals> = {}): RevenueSignals => ({
  occupancyPct: 60, adrCents: 50000, revparCents: 30000, revenueCents: 1_000_000, unitCount: 5, rules: [fullRule()], ...over,
});

const emptyReporting = (over: Partial<ReportingInput> = {}): ReportingInput => ({
  now: '2026-07-24T00:00:00Z', from: '2026-06-24', to: '2026-07-24', currency: 'BRL',
  units: [], agreements: [], invoices: [], payments: [], deposits: [], bills: [], apPayments: [],
  leads: [], workOrders: [], holds: [], ledgerBalanced: true, ...over,
});

// Every revenue-insight slug + which parts it carries (all have title/detail;
// most have an action; the two informational ones do not).
const REVENUE_SLUGS: Array<{ slug: string; action: boolean }> = [
  { slug: 'no_pricing', action: true },
  { slug: 'no_occupancy_tiers', action: true },
  { slug: 'no_weekend', action: true },
  { slug: 'no_floor', action: true },
  { slug: 'no_ceiling', action: true },
  { slug: 'no_los', action: true },
  { slug: 'adr_at_ceiling', action: true },
  { slug: 'occupancy_strong', action: true },
  { slug: 'occupancy_soft', action: true },
  { slug: 'revenue_healthy', action: false },
  { slug: 'revenue_no_data', action: false },
];
const LOCALES = ['en', 'pt-BR', 'es', 'fr', 'it', 'de'];

test('(a) computeRevenueInsights attaches titleKey/messageKey + params to every insight', () => {
  // rules:[] → no_pricing; plus the config-gap + demand insights across scenarios.
  const scenarios = [
    computeRevenueInsights(sig({ rules: [] })),
    computeRevenueInsights(sig({ occupancyPct: 22 })),
    computeRevenueInsights(sig({ occupancyPct: 92 })),
    computeRevenueInsights(sig({ rules: [fullRule({ occupancyTiers: [], minCents: undefined })] })),
    computeRevenueInsights(sig({ adrCents: 130000 })),
  ];
  const all = scenarios.flat();
  assert.ok(all.length > 0);
  for (const i of all) {
    assert.ok(i.titleKey && i.titleKey.startsWith('insight.'), `titleKey on ${i.title}`);
    assert.ok(i.messageKey && i.messageKey.endsWith('.detail'), `messageKey on ${i.title}`);
    assert.ok(i.params && typeof i.params === 'object', `params object on ${i.title}`);
    if (i.action) assert.ok(i.actionKey, `actionKey when action present on ${i.title}`);
  }
});

test('(a) computeInsights attaches titleKey/messageKey + params to every insight', () => {
  const ins = computeInsights(emptyReporting({
    ledgerBalanced: false, // → ledger_unbalanced (has no params originally)
    units: [{ id: 'u1', label: 'A1', active: true }],
    invoices: [{ id: 'i1', agreementId: 'a1', issuedAt: '2026-01-01', dueAt: '2026-02-01', totalCents: 5000, paidCents: 0, status: 'open' }],
  }));
  assert.ok(ins.length > 0);
  for (const i of ins) {
    assert.ok(i.titleKey && i.titleKey === `insight.${i.code}.title`, `titleKey derived from code on ${i.title}`);
    assert.ok(i.messageKey === `insight.${i.code}.detail`, `messageKey derived from code on ${i.title}`);
    assert.ok(i.params && typeof i.params === 'object', `params object on ${i.title}`);
    if (i.action != null) assert.ok(i.actionKey === `insight.${i.code}.action`, `actionKey on ${i.title}`);
  }
});

test('(b) interpolating the fr revenue template with params re-inserts the number', () => {
  const soft = computeRevenueInsights(sig({ occupancyPct: 22 })).find((i) => i.titleKey === 'insight.occupancy_soft.title');
  assert.ok(soft, 'soft-occupancy insight present');
  const frCat = mergedCatalog('fr');
  const tpl = frCat[soft!.titleKey!];
  assert.ok(tpl && tpl.includes('{pct}'), 'fr template carries the {pct} placeholder');
  const rendered = interpolate(tpl!, soft!.params);
  assert.ok(rendered.includes('22'), `fr rendering contains the value 22: "${rendered}"`);
  assert.ok(!rendered.includes('{pct}'), 'no placeholder left after interpolation');
});

test('(b) interpolating the fr reporting template with params re-inserts the number', () => {
  const ins = computeInsights(emptyReporting({
    units: [{ id: 'u1', label: 'A1', active: true }],
    invoices: [{ id: 'i1', agreementId: 'a1', issuedAt: '2026-01-01', dueAt: '2026-02-01', totalCents: 5000, paidCents: 0, status: 'open' }],
  }));
  const over90 = ins.find((i) => i.code === 'ar_over90');
  assert.ok(over90 && over90.titleKey === 'insight.ar_over90.title');
  const frTpl = mergedCatalog('fr')[over90!.titleKey!];
  assert.ok(frTpl, 'fr template exists for ar_over90');
  const rendered = interpolate(frTpl!, over90!.params);
  assert.ok(rendered.includes(String(over90!.params!['n'])), `fr rendering re-inserts {n}: "${rendered}"`);
});

test('(c) every revenue-insight key exists in all six locales (parity)', () => {
  const cats = Object.fromEntries(LOCALES.map((l) => [l, mergedCatalog(l)]));
  for (const { slug, action } of REVENUE_SLUGS) {
    const keys = [`insight.${slug}.title`, `insight.${slug}.detail`].concat(action ? [`insight.${slug}.action`] : []);
    for (const key of keys) {
      for (const loc of LOCALES) {
        assert.ok(cats[loc]![key], `${loc} is missing ${key}`);
      }
      // The non-English versions must actually be translated, not copied.
      for (const loc of ['pt-BR', 'es', 'fr', 'it', 'de']) {
        assert.notEqual(cats[loc]![key], cats['en']![key], `${loc} should translate ${key}`);
      }
    }
  }
});

test('(c) the English title/detail still render identically to the en catalog templates', () => {
  // rules:[] → no_pricing (no params). English output must equal the en template.
  const enCat = mergedCatalog('en');
  const noPricing = computeRevenueInsights(sig({ rules: [] })).find((i) => i.titleKey === 'insight.no_pricing.title');
  assert.ok(noPricing);
  assert.equal(noPricing!.title, enCat['insight.no_pricing.title']);
  assert.equal(noPricing!.detail, enCat['insight.no_pricing.detail']);
  assert.equal(noPricing!.action, enCat['insight.no_pricing.action']);
  // A param-bearing one: the English title interpolates the same value the en template would.
  const soft = computeRevenueInsights(sig({ occupancyPct: 22 })).find((i) => i.titleKey === 'insight.occupancy_soft.title');
  assert.equal(soft!.title, interpolate(enCat['insight.occupancy_soft.title']!, soft!.params));
});
