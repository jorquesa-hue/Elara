// Owner distributions — the capital-return arm. An operator returns net
// operating income to a property's owning legal entity (the SPE / fund / owner)
// by paying out cash: a distribution (an owner draw). It posts DR equity:
// distributions / CR assets:cash — cash leaves the business and owner equity is
// reduced. Because it MOVES MONEY OUT it is policy-gated in the App (a large
// distribution escalates for human approval, exactly like bill.pay). This
// registry owns the ledger posting; the App gates it and stamps the entity /
// property so the distribution attributes to the right community + owner.

import type { Ledger } from './ledger.ts';

export interface OwnerDistribution {
  id: string;
  tenantId: string;
  entityId: string; // the owning legal entity receiving the distribution
  propertyId?: string; // the community the distribution is attributed to
  amountCents: number;
  currency: string;
  periodStart?: string; // the NOI period this distribution relates to
  periodEnd?: string;
  memo?: string;
  recordedAt: string;
}

export class DistributionError extends Error {}

/** GL accounts a distribution touches (a draw against owner equity, paid in cash). */
export const DISTRIBUTION_ACCOUNTS = { draw: 'equity:distributions', cash: 'assets:cash' } as const;

export class Distributions {
  private distributions = new Map<string, OwnerDistribution>();

  constructor(private readonly ledger: Ledger) {}

  /** Load stored distributions for cold-start rehydration (no ledger re-post —
   *  the journal lines are rehydrated separately, verbatim). */
  hydrate(records: readonly OwnerDistribution[]): void {
    for (const r of records) this.distributions.set(r.id, { ...r });
  }

  /** Record (and post) a distribution to an owning entity. Posts a balanced
   *  entry DR equity:distributions / CR assets:cash, tenant-/entity-/property-
   *  stamped. Throws on a duplicate id or a non-positive amount. */
  record(input: {
    id: string; tenantId: string; entityId: string; amountCents: number; recordedAt: string;
    currency?: string; propertyId?: string; periodStart?: string; periodEnd?: string; memo?: string;
  }): OwnerDistribution {
    if (this.distributions.has(input.id)) throw new DistributionError(`duplicate distribution: ${input.id}`);
    if (!input.entityId) throw new DistributionError(`distribution ${input.id}: entityId is required`);
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new DistributionError(`distribution ${input.id}: amount must be a positive integer`);
    const currency = input.currency ?? 'BRL';

    this.ledger.post({
      entryId: `je-dist-${input.id}`,
      postedAt: input.recordedAt,
      currency,
      tenantId: input.tenantId,
      entityId: input.entityId,
      ...(input.propertyId ? { propertyId: input.propertyId } : {}),
      memo: `owner distribution ${input.id}`,
      lines: [
        { account: DISTRIBUTION_ACCOUNTS.draw, debitCents: input.amountCents },
        { account: DISTRIBUTION_ACCOUNTS.cash, creditCents: input.amountCents },
      ],
    });

    const d: OwnerDistribution = {
      id: input.id,
      tenantId: input.tenantId,
      entityId: input.entityId,
      amountCents: input.amountCents,
      currency,
      recordedAt: input.recordedAt,
      ...(input.propertyId ? { propertyId: input.propertyId } : {}),
      ...(input.periodStart ? { periodStart: input.periodStart } : {}),
      ...(input.periodEnd ? { periodEnd: input.periodEnd } : {}),
      ...(input.memo ? { memo: input.memo } : {}),
    };
    this.distributions.set(d.id, d);
    return this.get(d.id);
  }

  get(id: string): OwnerDistribution {
    const d = this.distributions.get(id);
    if (!d) throw new DistributionError(`unknown distribution: ${id}`);
    return { ...d };
  }

  list(tenantId: string): OwnerDistribution[] {
    return [...this.distributions.values()].filter((d) => d.tenantId === tenantId).map((d) => this.get(d.id));
  }
}
