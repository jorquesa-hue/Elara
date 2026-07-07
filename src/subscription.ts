// Per-unit SaaS metering — the platform's charge to the OPERATOR (revenue gate:
// per-unit SaaS). This is distinct from guest billing, which flows through the
// ledger. Pure arithmetic over integer cents; no I/O.

export interface SubscriptionPlan {
  perUnitCents: number;
  currency: string;
}

export interface SubscriptionMeter {
  unitCount: number;
  perUnitCents: number;
  totalCents: number;
  currency: string;
}

export class SubscriptionError extends Error {}

export function meterSubscription(unitCount: number, plan: SubscriptionPlan): SubscriptionMeter {
  if (!Number.isInteger(unitCount) || unitCount < 0) {
    throw new SubscriptionError('unitCount must be a non-negative integer');
  }
  if (!Number.isInteger(plan.perUnitCents) || plan.perUnitCents < 0) {
    throw new SubscriptionError('perUnitCents must be a non-negative integer');
  }
  return {
    unitCount,
    perUnitCents: plan.perUnitCents,
    totalCents: unitCount * plan.perUnitCents,
    currency: plan.currency,
  };
}
