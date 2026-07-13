// Accounts payable — the mirror of billing (receivables). A bill is what we owe
// a payee (a party in the payee role); an AP payment settles it. Every mutation
// posts to the ledger, so payables inherit the balance invariant (6) by
// construction. A resident refund is modelled here too: it becomes a bill to the
// resident-party settled like any vendor payment (#22), so maintenance (#3),
// vendor payouts (#21), and refunds share one structure.

import { Ledger } from './ledger.ts';
import { ACCOUNTS } from './billing.ts';

export interface BillLine {
  description: string;
  account: string; // the expense/liability debited when the bill is booked
  amountCents: number;
}

export type BillStatus = 'open' | 'partially_paid' | 'paid' | 'void';

export interface Bill {
  id: string;
  tenantId: string;
  payeeId: string; // party in the payee role
  entityId?: string; // paying legal entity
  propertyId?: string; // the community/property the expense belongs to (owner statements)
  issuedAt: string;
  dueAt: string;
  currency: string;
  lines: BillLine[];
  totalCents: number;
  paidCents: number;
  status: BillStatus;
  memo?: string;
}

export type ApMethod = 'pix' | 'transfer' | 'card' | 'cash';

export interface ApPayment {
  id: string;
  billId: string;
  amountCents: number;
  method: ApMethod;
  paidAt: string;
  status: 'settled' | 'reversed';
}

export class PayablesError extends Error {}

export class Payables {
  private bills = new Map<string, Bill>();
  private payments = new Map<string, ApPayment>();

  /** Load stored bills + AP payments for cold-start rehydration (no ledger post). */
  hydrate(bills: readonly Bill[], apPayments: readonly ApPayment[]): void {
    for (const b of bills) this.bills.set(b.id, { ...b, lines: b.lines.map((l) => ({ ...l })) });
    for (const p of apPayments) this.payments.set(p.id, { ...p });
  }

  constructor(private readonly ledger: Ledger) {}

  /** Book a bill: DR each line's account, CR accounts payable. */
  issue(input: {
    id: string;
    tenantId: string;
    payeeId: string;
    entityId?: string;
    propertyId?: string;
    issuedAt: string;
    dueAt: string;
    currency?: string;
    lines: BillLine[];
    memo?: string;
  }): Bill {
    if (this.bills.has(input.id)) throw new PayablesError(`duplicate bill: ${input.id}`);
    if (input.lines.length === 0) throw new PayablesError(`bill ${input.id} has no lines`);
    const totalCents = input.lines.reduce((s, l) => s + l.amountCents, 0);
    if (totalCents <= 0) throw new PayablesError(`bill ${input.id} total must be positive`);

    const bill: Bill = {
      id: input.id,
      tenantId: input.tenantId,
      payeeId: input.payeeId,
      entityId: input.entityId,
      propertyId: input.propertyId,
      issuedAt: input.issuedAt,
      dueAt: input.dueAt,
      currency: input.currency ?? 'BRL',
      lines: input.lines.map((l) => ({ ...l })),
      totalCents,
      paidCents: 0,
      status: 'open',
      memo: input.memo,
    };

    // AP entries have no agreement, so the tenant tag is the ONLY thing that
    // scopes them into tenant-level reads (trial balance, persistence snapshot).
    this.ledger.post({
      entryId: `bill-${input.id}`,
      postedAt: input.issuedAt,
      currency: bill.currency,
      tenantId: bill.tenantId,
      entityId: input.entityId,
      propertyId: input.propertyId,
      memo: input.memo ?? `bill ${input.id}`,
      lines: [
        ...input.lines.map((l) => ({ account: l.account, debitCents: l.amountCents, memo: l.description })),
        { account: ACCOUNTS.accountsPayable, creditCents: totalCents },
      ],
    });

    this.bills.set(bill.id, bill);
    return this.get(bill.id);
  }

  get(id: string): Bill {
    const b = this.bills.get(id);
    if (!b) throw new PayablesError(`unknown bill: ${id}`);
    return { ...b, lines: b.lines.map((l) => ({ ...l })) };
  }

  /** Settle a bill: DR accounts payable, CR cash. */
  pay(input: {
    id: string;
    billId: string;
    amountCents: number;
    method: ApMethod;
    paidAt: string;
  }): ApPayment {
    if (this.payments.has(input.id)) throw new PayablesError(`duplicate ap payment: ${input.id}`);
    const bill = this.bills.get(input.billId);
    if (!bill) throw new PayablesError(`unknown bill: ${input.billId}`);
    if (bill.status === 'void' || bill.status === 'paid') {
      throw new PayablesError(`bill ${input.billId} is ${bill.status}; cannot pay`);
    }
    if (input.amountCents <= 0) throw new PayablesError('payment amount must be positive');
    if (bill.paidCents + input.amountCents > bill.totalCents) {
      throw new PayablesError(`payment would overpay bill ${input.billId}`);
    }

    this.ledger.post({
      entryId: `appay-${input.id}`,
      postedAt: input.paidAt,
      currency: bill.currency,
      tenantId: bill.tenantId,
      memo: `ap payment ${input.id} on bill ${input.billId}`,
      lines: [
        { account: ACCOUNTS.accountsPayable, debitCents: input.amountCents },
        { account: ACCOUNTS.cash, creditCents: input.amountCents },
      ],
    });

    bill.paidCents += input.amountCents;
    bill.status = bill.paidCents === bill.totalCents ? 'paid' : 'partially_paid';

    const pay: ApPayment = {
      id: input.id,
      billId: input.billId,
      amountCents: input.amountCents,
      method: input.method,
      paidAt: input.paidAt,
      status: 'settled',
    };
    this.payments.set(pay.id, pay);
    return { ...pay };
  }

  openBills(): readonly Bill[] {
    return [...this.bills.values()]
      .filter((b) => b.status === 'open' || b.status === 'partially_paid')
      .map((b) => this.get(b.id));
  }

  allBills(): readonly Bill[] {
    return [...this.bills.values()].map((b) => this.get(b.id));
  }

  allPayments(): readonly ApPayment[] {
    return [...this.payments.values()].map((p) => ({ ...p }));
  }
}
