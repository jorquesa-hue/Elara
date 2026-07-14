// Owner capital contributions — the money-IN counterpart to distributions (7A).
// An owner/investor puts capital INTO a legal entity (the SPE/fund): it posts
// DR assets:cash / CR equity:contributions — cash enters the business and owner
// equity rises. Money coming IN is not a payout risk, so (unlike a distribution)
// it is RBAC-only, not policy-gated. Together with distributions this completes
// the owner CAPITAL ACCOUNT: net capital = contributions − distributions.

import type { Ledger } from './ledger.ts';

export interface OwnerContribution {
  id: string;
  tenantId: string;
  entityId: string; // the owning legal entity receiving the capital
  propertyId?: string; // the community the contribution is attributed to
  amountCents: number;
  currency: string;
  memo?: string;
  recordedAt: string;
}

export class ContributionError extends Error {}

/** GL accounts a contribution touches (cash in, credited to owner equity). */
export const CONTRIBUTION_ACCOUNTS = { cash: 'assets:cash', equity: 'equity:contributions' } as const;

export class Contributions {
  private contributions = new Map<string, OwnerContribution>();

  constructor(private readonly ledger: Ledger) {}

  /** Load stored contributions for cold-start rehydration (no ledger re-post —
   *  the journal lines are rehydrated separately, verbatim). */
  hydrate(records: readonly OwnerContribution[]): void {
    for (const r of records) this.contributions.set(r.id, { ...r });
  }

  /** Record (and post) a capital contribution to an owning entity. Posts a
   *  balanced entry DR assets:cash / CR equity:contributions, tenant-/entity-/
   *  property-stamped. Throws on a duplicate id or a non-positive amount. */
  record(input: {
    id: string; tenantId: string; entityId: string; amountCents: number; recordedAt: string;
    currency?: string; propertyId?: string; memo?: string;
  }): OwnerContribution {
    if (this.contributions.has(input.id)) throw new ContributionError(`duplicate contribution: ${input.id}`);
    if (!input.entityId) throw new ContributionError(`contribution ${input.id}: entityId is required`);
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new ContributionError(`contribution ${input.id}: amount must be a positive integer`);
    const currency = input.currency ?? 'BRL';

    this.ledger.post({
      entryId: `je-contrib-${input.id}`,
      postedAt: input.recordedAt,
      currency,
      tenantId: input.tenantId,
      entityId: input.entityId,
      ...(input.propertyId ? { propertyId: input.propertyId } : {}),
      memo: `owner contribution ${input.id}`,
      lines: [
        { account: CONTRIBUTION_ACCOUNTS.cash, debitCents: input.amountCents },
        { account: CONTRIBUTION_ACCOUNTS.equity, creditCents: input.amountCents },
      ],
    });

    const c: OwnerContribution = {
      id: input.id,
      tenantId: input.tenantId,
      entityId: input.entityId,
      amountCents: input.amountCents,
      currency,
      recordedAt: input.recordedAt,
      ...(input.propertyId ? { propertyId: input.propertyId } : {}),
      ...(input.memo ? { memo: input.memo } : {}),
    };
    this.contributions.set(c.id, c);
    return this.get(c.id);
  }

  get(id: string): OwnerContribution {
    const c = this.contributions.get(id);
    if (!c) throw new ContributionError(`unknown contribution: ${id}`);
    return { ...c };
  }

  list(tenantId: string): OwnerContribution[] {
    return [...this.contributions.values()].filter((c) => c.tenantId === tenantId).map((c) => this.get(c.id));
  }
}
