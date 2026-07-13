// Security deposits: held as a liability, refunded with itemized deductions.
// Deductions move from the held liability into deduction revenue; the net is
// returned to the guest as cash. Every movement flows through the ledger.

import { Ledger } from './ledger.ts';
import { ACCOUNTS } from './billing.ts';

export type DepositStatus = 'held' | 'refunded';

export interface Deduction {
  reason: string;
  amountCents: number;
}

export interface Deposit {
  id: string;
  agreementId: string;
  amountCents: number;
  currency: string;
  status: DepositStatus;
  heldAt: string;
  refundedAt?: string;
  deductions: Deduction[];
  refundedCents?: number;
  /** The cash GL account the money sits in (a trust account when segregated) —
   *  the refund returns from the SAME account. Defaults to operating cash. */
  cashAccount?: string;
}

export class DepositError extends Error {}

export class Deposits {
  private deposits = new Map<string, Deposit>();

  /** Load stored deposits for cold-start rehydration (no ledger post). */
  hydrate(records: readonly Deposit[]): void {
    for (const r of records) this.deposits.set(r.id, { ...r, deductions: (r.deductions ?? []).map((d) => ({ ...d })) });
  }

  constructor(private readonly ledger: Ledger) {}

  hold(input: {
    id: string;
    agreementId: string;
    amountCents: number;
    currency?: string;
    heldAt: string;
    /** The cash GL account this deposit's money goes into — a segregated TRUST
     *  account when the tenant has one configured; defaults to operating cash. */
    cashAccount?: string;
    propertyId?: string;
    entityId?: string;
  }): Deposit {
    if (this.deposits.has(input.id)) throw new DepositError(`duplicate deposit: ${input.id}`);
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
      throw new DepositError(`deposit ${input.id}: amount must be a positive integer`);
    }
    const currency = input.currency ?? 'BRL';
    const cashAccount = input.cashAccount ?? ACCOUNTS.cash;

    // Guest cash received and parked as a liability we owe back.
    this.ledger.post({
      entryId: `je-dep-hold-${input.id}`,
      postedAt: input.heldAt,
      currency,
      agreementId: input.agreementId,
      ...(input.entityId ? { entityId: input.entityId } : {}),
      ...(input.propertyId ? { propertyId: input.propertyId } : {}),
      memo: `deposit ${input.id} held`,
      lines: [
        { account: cashAccount, debitCents: input.amountCents },
        { account: ACCOUNTS.depositsHeld, creditCents: input.amountCents },
      ],
    });

    const deposit: Deposit = {
      id: input.id,
      agreementId: input.agreementId,
      amountCents: input.amountCents,
      currency,
      status: 'held',
      heldAt: input.heldAt,
      deductions: [],
      ...(cashAccount !== ACCOUNTS.cash ? { cashAccount } : {}),
    };
    this.deposits.set(deposit.id, deposit);
    return this.get(deposit.id);
  }

  refund(id: string, at: string, deductions: Deduction[] = []): Deposit {
    const deposit = this.deposits.get(id);
    if (!deposit) throw new DepositError(`unknown deposit: ${id}`);
    if (deposit.status !== 'held') throw new DepositError(`deposit ${id} already ${deposit.status}`);

    const deducted = deductions.reduce((s, d) => s + d.amountCents, 0);
    if (deducted < 0) throw new DepositError(`deposit ${id}: deductions cannot be negative`);
    if (deducted > deposit.amountCents) {
      throw new DepositError(`deposit ${id}: deductions exceed held amount`);
    }
    const refundCents = deposit.amountCents - deducted;

    // Release the full liability; deductions become revenue, remainder is cash
    // out FROM THE SAME (trust) account the money went into.
    const cashAccount = deposit.cashAccount ?? ACCOUNTS.cash;
    const lines = [{ account: ACCOUNTS.depositsHeld, debitCents: deposit.amountCents }];
    if (deducted > 0) lines.push({ account: ACCOUNTS.deductionRevenue, creditCents: deducted } as never);
    if (refundCents > 0) lines.push({ account: cashAccount, creditCents: refundCents } as never);

    this.ledger.post({
      entryId: `je-dep-refund-${id}`,
      postedAt: at,
      currency: deposit.currency,
      agreementId: deposit.agreementId,
      memo: `deposit ${id} refunded`,
      lines,
    });

    deposit.status = 'refunded';
    deposit.refundedAt = at;
    deposit.deductions = deductions.map((d) => ({ ...d }));
    deposit.refundedCents = refundCents;
    return this.get(id);
  }

  get(id: string): Deposit {
    const d = this.deposits.get(id);
    if (!d) throw new DepositError(`unknown deposit: ${id}`);
    return { ...d, deductions: d.deductions.map((x) => ({ ...x })) };
  }

  all(): readonly Deposit[] {
    return [...this.deposits.values()].map((d) => this.get(d.id));
  }
}
