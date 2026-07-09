// Revenue management & dynamic pricing (#1). A pricing rule turns a base rate
// into a nightly quote by applying explainable, multiplicative factors —
// occupancy, weekend, lead-time, length-of-stay, and season — then clamping to a
// floor/ceiling. Everything is PURE and deterministic (zero-dep): the same
// inputs always yield the same quote with the same breakdown, so it is auditable
// and testable. The "AI/demand" seam is the occupancyPct / demand signal fed in
// — an ML model can supply it, but the arithmetic here never guesses.
//
// Factors are basis points where 10000 = 1.0x (no change); 12500 = +25%.

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
