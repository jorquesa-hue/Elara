// Revenue management & dynamic pricing (#1). A pricing rule turns a base rate
// into a nightly quote by applying explainable, multiplicative factors —
// occupancy, weekend, lead-time, length-of-stay, and season — then clamping to a
// floor/ceiling. Everything is PURE and deterministic (zero-dep): the same
// inputs always yield the same quote with the same breakdown, so it is auditable
// and testable. The "AI/demand" seam is the occupancyPct / demand signal fed in
// — an ML model can supply it, but the arithmetic here never guesses.
//
// Factors are basis points where 10000 = 1.0x (no change); 12500 = +25%.

import { interpolate } from './i18n.ts';

export interface OccupancyTier { minOccupancyPct: number; factorBps: number; }
export interface LeadTimeTier { maxDaysOut: number; factorBps: number; } // last-minute → small maxDaysOut
export interface LosDiscount { minNights: number; discountBps: number; } // length-of-stay discount
export interface SeasonWindow { start: string; end: string; factorBps: number; } // [start, end)

export interface PricingRule {
  id: string;
  tenantId: string;
  name: string;
  baseCents: number;
  minCents?: number;
  maxCents?: number;
  weekendFactorBps?: number; // applied when check-in is Fri/Sat
  occupancyTiers?: OccupancyTier[];
  leadTimeTiers?: LeadTimeTier[];
  losDiscounts?: LosDiscount[];
  seasons?: SeasonWindow[];
}

export interface QuoteContext {
  checkIn: string; // ISO date (YYYY-MM-DD)
  nights: number;
  occupancyPct?: number; // 0..100 — the demand signal
  asOf?: string; // for lead-time; omitted → no lead-time factor
}

export interface PricingFactor { name: string; factorBps: number; }

export interface PricingQuote {
  baseCents: number;
  nightlyCents: number;
  totalCents: number;
  factors: PricingFactor[]; // in application order — the explanation
}

export class RevenueError extends Error {}

function dow(dateStr: string): number {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay(); // 0=Sun … 5=Fri, 6=Sat
}
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}
function applyBps(cents: number, bps: number): number {
  return Math.round((cents * bps) / 10000);
}

/** Pure: compute a nightly + total quote from a rule and a context, with the
 *  ordered list of factors that produced it. */
export function computeQuote(rule: PricingRule, ctx: QuoteContext): PricingQuote {
  if (!Number.isInteger(rule.baseCents) || rule.baseCents <= 0) {
    throw new RevenueError(`pricing rule ${rule.id}: baseCents must be a positive integer`);
  }
  if (!Number.isInteger(ctx.nights) || ctx.nights <= 0) {
    throw new RevenueError('nights must be a positive integer');
  }
  const factors: PricingFactor[] = [];
  let rate = rule.baseCents;

  // Occupancy: highest matching tier wins (higher occupancy → higher price).
  if (rule.occupancyTiers?.length && ctx.occupancyPct !== undefined) {
    const tier = [...rule.occupancyTiers]
      .filter((t) => ctx.occupancyPct! >= t.minOccupancyPct)
      .sort((a, b) => b.minOccupancyPct - a.minOccupancyPct)[0];
    if (tier) { rate = applyBps(rate, tier.factorBps); factors.push({ name: `occupancy≥${tier.minOccupancyPct}%`, factorBps: tier.factorBps }); }
  }

  // Weekend uplift.
  if (rule.weekendFactorBps && (dow(ctx.checkIn) === 5 || dow(ctx.checkIn) === 6)) {
    rate = applyBps(rate, rule.weekendFactorBps);
    factors.push({ name: 'weekend', factorBps: rule.weekendFactorBps });
  }

  // Lead time: tightest matching tier (fewest days out) wins.
  if (rule.leadTimeTiers?.length && ctx.asOf !== undefined) {
    const daysOut = daysBetween(ctx.asOf, ctx.checkIn);
    const tier = [...rule.leadTimeTiers]
      .filter((t) => daysOut <= t.maxDaysOut)
      .sort((a, b) => a.maxDaysOut - b.maxDaysOut)[0];
    if (tier) { rate = applyBps(rate, tier.factorBps); factors.push({ name: `lead≤${tier.maxDaysOut}d`, factorBps: tier.factorBps }); }
  }

  // Season: first window containing the check-in date.
  const season = rule.seasons?.find((s) => ctx.checkIn >= s.start && ctx.checkIn < s.end);
  if (season) { rate = applyBps(rate, season.factorBps); factors.push({ name: `season ${season.start}`, factorBps: season.factorBps }); }

  // Length-of-stay discount: highest matching minNights.
  if (rule.losDiscounts?.length) {
    const d = [...rule.losDiscounts]
      .filter((x) => ctx.nights >= x.minNights)
      .sort((a, b) => b.minNights - a.minNights)[0];
    if (d) { const f = 10000 - d.discountBps; rate = applyBps(rate, f); factors.push({ name: `los≥${d.minNights}n`, factorBps: f }); }
  }

  // Clamp to floor/ceiling.
  if (rule.minCents !== undefined && rate < rule.minCents) { rate = rule.minCents; factors.push({ name: 'floor', factorBps: 10000 }); }
  if (rule.maxCents !== undefined && rate > rule.maxCents) { rate = rule.maxCents; factors.push({ name: 'ceiling', factorBps: 10000 }); }

  return { baseCents: rule.baseCents, nightlyCents: rate, totalCents: rate * ctx.nights, factors };
}

export interface RevenueKpis {
  occupancyPct: number; // 0..100
  adrCents: number; // average daily rate = revenue / room-nights sold
  revparCents: number; // revenue per available room-night
}

/** Pure: the three headline hospitality metrics. */
export function revenueKpis(input: { availableRoomNights: number; soldRoomNights: number; revenueCents: number }): RevenueKpis {
  const { availableRoomNights, soldRoomNights, revenueCents } = input;
  return {
    occupancyPct: availableRoomNights > 0 ? Math.round((soldRoomNights / availableRoomNights) * 1000) / 10 : 0,
    adrCents: soldRoomNights > 0 ? Math.round(revenueCents / soldRoomNights) : 0,
    revparCents: availableRoomNights > 0 ? Math.round(revenueCents / availableRoomNights) : 0,
  };
}

// --- revenue-management intelligence ---------------------------------------
// A pure, deterministic recommender over the tenant's demand signals + pricing
// rules — the revenue-manager's advisor. It never moves money or changes a rule;
// it surfaces prioritized, explainable opportunities and risks ("occupancy is
// strong — raise the ceiling", "no rate floor — a dip could price below cost"),
// each stating the metric it fired on and the lever to pull. Same discipline as
// the reporting insight feed: the arithmetic is transparent, an LLM can narrate.

export type RevenueInsightSeverity = 'critical' | 'warning' | 'opportunity' | 'info' | 'positive';
export interface RevenueInsight {
  severity: RevenueInsightSeverity;
  title: string;
  detail: string;
  metric?: { value: number; kind: 'money' | 'number' | 'percent' };
  action?: string;
  /** Stable i18n keys for the title/detail/action templates, with the English
   *  strings above as the fallback. The portal renders tt(key) + interpolate(params). */
  titleKey?: string;
  messageKey?: string;
  actionKey?: string;
  /** Interpolation values for the translated templates (e.g. {pct}, {name}). */
  params?: Record<string, string | number>;
}

// English templates for each revenue insight, keyed by a stable slug. The plain
// English title/detail/action are rendered from these same templates + params,
// so the English output is identical whether or not a locale is loaded; the i18n
// catalog holds a translation of each under `insight.<slug>.{title|detail|action}`.
const REVENUE_INSIGHT_TEMPLATES: Record<string, { title: string; detail: string; action?: string }> = {
  no_pricing: {
    title: 'No dynamic pricing rule yet',
    detail: 'You are pricing statically, so your rates never respond to demand, weekends, lead time, or length of stay — the classic way revenue is left on the table.',
    action: 'Create a pricing rule below to start pricing dynamically.',
  },
  no_occupancy_tiers: {
    title: 'Rate does not respond to occupancy',
    detail: '“{name}” has no occupancy tiers, so a full week and a dead week are priced the same. Occupancy-based tiers are the core of dynamic pricing.',
    action: 'Add occupancy tiers (e.g. +10% at 60%, +30% at 85%).',
  },
  no_weekend: {
    title: 'No weekend uplift set',
    detail: 'Friday/Saturday check-ins usually command a premium; without an uplift you are pricing peak nights like mid-week.',
    action: 'Set a weekend uplift (e.g. +25%).',
  },
  no_floor: {
    title: 'No rate floor',
    detail: 'With no floor, a soft-demand discount can drive the nightly rate below your break-even.',
    action: 'Set a floor at or above your cost per night.',
  },
  no_ceiling: {
    title: 'No rate ceiling',
    detail: 'With no ceiling, a high-demand multiplier can overshoot what the market will pay and deter bookings.',
    action: 'Set a ceiling near your best historical ADR.',
  },
  no_los: {
    title: 'No length-of-stay discount',
    detail: 'Longer stays cut per-night turnover and cleaning cost; a weekly/monthly discount fills gap nights and wins direct bookings.',
    action: 'Add a length-of-stay discount (e.g. −10% at 7 nights).',
  },
  adr_at_ceiling: {
    title: 'ADR is at your rate ceiling',
    detail: 'Your realized ADR has reached the ceiling on “{name}”, so peak-date demand can no longer lift the rate.',
    action: 'Raise the ceiling to test higher peak pricing.',
  },
  occupancy_strong: {
    title: 'Occupancy is strong at {pct}%',
    detail: 'Demand is outrunning supply — there is likely room to raise rates without hurting fill.',
    action: 'Increase the occupancy-tier uplift or the ceiling.',
  },
  occupancy_soft: {
    title: 'Occupancy is soft at {pct}%',
    detail: 'Empty nights never come back. Stimulate demand before the dates pass.',
    action: 'Lower the floor, deepen the length-of-stay discount, or run a promotion.',
  },
  revenue_healthy: {
    title: 'Revenue setup looks healthy',
    detail: 'Occupancy {pct}% at an ADR of {adr} cents gives a RevPAR of {revpar} cents.',
  },
  revenue_no_data: {
    title: 'Not enough data yet',
    detail: 'Add units, bookings and a pricing rule to unlock revenue recommendations.',
  },
};

/** Build a RevenueInsight from a slug: render the English title/detail/action
 *  from the templates + params, and attach the i18n keys so the portal can show
 *  the translated equivalents. */
function revenueInsight(
  slug: keyof typeof REVENUE_INSIGHT_TEMPLATES,
  severity: RevenueInsightSeverity,
  params: Record<string, string | number> = {},
  metric?: { value: number; kind: 'money' | 'number' | 'percent' },
): RevenueInsight {
  const tpl = REVENUE_INSIGHT_TEMPLATES[slug]!;
  const ins: RevenueInsight = {
    severity,
    title: interpolate(tpl.title, params),
    detail: interpolate(tpl.detail, params),
    titleKey: `insight.${slug}.title`,
    messageKey: `insight.${slug}.detail`,
    params,
  };
  if (tpl.action) { ins.action = interpolate(tpl.action, params); ins.actionKey = `insight.${slug}.action`; }
  if (metric) ins.metric = metric;
  return ins;
}
export interface RevenueSignals {
  occupancyPct: number; // 0..100
  adrCents: number;
  revparCents: number;
  revenueCents: number;
  unitCount: number;
  rules: PricingRule[];
}

/** Scan demand signals + pricing rules and surface prioritized revenue findings.
 *  Deterministic given the same input; ordered critical → positive. */
export function computeRevenueInsights(sig: RevenueSignals): RevenueInsight[] {
  const out: RevenueInsight[] = [];
  const order: Record<RevenueInsightSeverity, number> = { critical: 0, warning: 1, opportunity: 2, info: 3, positive: 4 };
  const rules = sig.rules ?? [];

  // No dynamic pricing at all — the single biggest revenue gap.
  if (rules.length === 0) {
    out.push(revenueInsight('no_pricing', 'warning'));
  } else {
    // Configuration gaps on the primary (first) rule — each is a lever not pulled.
    const r = rules[0]!;
    if (!(r.occupancyTiers?.length)) out.push(revenueInsight('no_occupancy_tiers', 'opportunity', { name: r.name }));
    if (!r.weekendFactorBps) out.push(revenueInsight('no_weekend', 'info'));
    if (r.minCents === undefined) out.push(revenueInsight('no_floor', 'warning'));
    if (r.maxCents === undefined) out.push(revenueInsight('no_ceiling', 'info'));
    if (!(r.losDiscounts?.length)) out.push(revenueInsight('no_los', 'info'));
    // ADR pressed against the ceiling → the ceiling may be capping revenue.
    const cappedRule = rules.find((x) => x.maxCents !== undefined && sig.adrCents > 0 && sig.adrCents >= x.maxCents);
    if (cappedRule) out.push(revenueInsight('adr_at_ceiling', 'opportunity', { name: cappedRule.name }, { value: sig.adrCents, kind: 'money' }));
  }

  // Demand response from occupancy.
  if (sig.unitCount > 0) {
    if (sig.occupancyPct >= 80) out.push(revenueInsight('occupancy_strong', 'opportunity', { pct: sig.occupancyPct }, { value: sig.occupancyPct, kind: 'percent' }));
    else if (sig.occupancyPct < 40) out.push(revenueInsight('occupancy_soft', 'warning', { pct: sig.occupancyPct }, { value: sig.occupancyPct, kind: 'percent' }));
  }

  // A healthy, well-configured setup deserves a positive note.
  if (out.every((i) => i.severity !== 'critical' && i.severity !== 'warning') && sig.unitCount > 0 && sig.revparCents > 0) {
    out.push(revenueInsight('revenue_healthy', 'positive', { pct: sig.occupancyPct, adr: sig.adrCents, revpar: sig.revparCents }, { value: sig.revparCents, kind: 'money' }));
  }
  if (out.length === 0) out.push(revenueInsight('revenue_no_data', 'info'));

  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}

export class RevenueManagement {
  private rules = new Map<string, PricingRule>();

  setRule(rule: PricingRule): PricingRule {
    if (!rule.id || !rule.name) throw new RevenueError('pricing rule needs an id and a name');
    if (!Number.isInteger(rule.baseCents) || rule.baseCents <= 0) throw new RevenueError(`pricing rule ${rule.id}: baseCents must be a positive integer`);
    this.rules.set(rule.id, { ...rule });
    return { ...rule };
  }

  getRule(tenantId: string, id: string): PricingRule | null {
    const r = this.rules.get(id);
    return r && r.tenantId === tenantId ? { ...r } : null;
  }

  listRules(tenantId: string): PricingRule[] {
    return [...this.rules.values()].filter((r) => r.tenantId === tenantId).map((r) => ({ ...r }));
  }

  quote(tenantId: string, ruleId: string, ctx: QuoteContext): PricingQuote {
    const rule = this.getRule(tenantId, ruleId);
    if (!rule) throw new RevenueError(`unknown pricing rule: ${ruleId}`);
    return computeQuote(rule, ctx);
  }
}
