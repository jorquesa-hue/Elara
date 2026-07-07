// Rate plans: pricing per agreement kind. Quotes are pure arithmetic over
// integer cents; billing turns quotes into invoices and ledger entries.

import type { AgreementKind } from './agreement.ts';

export interface RatePlan {
  id: string;
  name: string;
  kind: AgreementKind;
  /** Per night for nightly plans; per month for monthly/lease plans. */
  baseCents: number;
  currency: string;
  depositCents?: number;
}

export interface Quote {
  planId: string;
  kind: AgreementKind;
  units: number; // nights or months
  unitCents: number;
  totalCents: number;
  currency: string;
}

export class RatePlanError extends Error {}

export class RatePlanBook {
  private plans = new Map<string, RatePlan>();

  add(plan: RatePlan): void {
    if (this.plans.has(plan.id)) throw new RatePlanError(`duplicate rate plan: ${plan.id}`);
    if (!Number.isInteger(plan.baseCents) || plan.baseCents <= 0) {
      throw new RatePlanError(`rate plan ${plan.id}: baseCents must be a positive integer`);
    }
    this.plans.set(plan.id, { ...plan });
  }

  get(id: string): RatePlan {
    const plan = this.plans.get(id);
    if (!plan) throw new RatePlanError(`unknown rate plan: ${id}`);
    return { ...plan };
  }

  quote(planId: string, opts: { nights?: number; months?: number }): Quote {
    const plan = this.get(planId);
    const units = plan.kind === 'nightly' ? opts.nights : opts.months;
    if (units === undefined || !Number.isInteger(units) || units <= 0) {
      throw new RatePlanError(
        `quote for ${plan.kind} plan ${planId} needs a positive integer ${plan.kind === 'nightly' ? 'nights' : 'months'}`,
      );
    }
    return {
      planId,
      kind: plan.kind,
      units,
      unitCents: plan.baseCents,
      totalCents: plan.baseCents * units,
      currency: plan.currency,
    };
  }
}
