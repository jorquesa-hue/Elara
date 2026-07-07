// Payments: records settled payments against invoices and posts the cash/AR
// movement. This module is deliberately provider-agnostic — kernel code never
// touches real payment-provider credentials (behavioral guardrail); a gateway
// adapter lives outside the kernel and calls in with already-settled facts.

import { Ledger } from './ledger.ts';
import { Billing, ACCOUNTS } from './billing.ts';

export type PaymentMethod = 'pix' | 'card' | 'transfer' | 'cash';

export interface Payment {
  id: string;
  invoiceId: string;
  amountCents: number;
  method: PaymentMethod;
  receivedAt: string;
  status: 'settled' | 'refunded';
}

export class PaymentError extends Error {}

export class Payments {
  private payments = new Map<string, Payment>();

  constructor(
    private readonly ledger: Ledger,
    private readonly billing: Billing,
  ) {}

  record(input: {
    id: string;
    invoiceId: string;
    amountCents: number;
    method: PaymentMethod;
    receivedAt: string;
  }): Payment {
    if (this.payments.has(input.id)) throw new PaymentError(`duplicate payment: ${input.id}`);
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
      throw new PaymentError(`payment ${input.id}: amount must be a positive integer`);
    }
    const invoice = this.billing.get(input.invoiceId);

    // Guard at the payments boundary so callers get a PaymentError, not a
    // leaked BillingError, for an over- or fully-paid invoice.
    if (invoice.status === 'void') {
      throw new PaymentError(`invoice ${input.invoiceId} is void; cannot pay`);
    }
    const remaining = invoice.totalCents - invoice.paidCents;
    if (input.amountCents > remaining) {
      throw new PaymentError(
        `payment ${input.id} of ${input.amountCents} exceeds ${remaining} remaining on invoice ${input.invoiceId}`,
      );
    }

    // Update invoice first — it re-validates before any ledger write.
    this.billing.applyPayment(input.invoiceId, input.amountCents);

    this.ledger.post({
      entryId: `je-${input.id}`,
      postedAt: input.receivedAt,
      currency: invoice.currency,
      agreementId: invoice.agreementId,
      memo: `payment ${input.id} on invoice ${input.invoiceId}`,
      lines: [
        { account: ACCOUNTS.cash, debitCents: input.amountCents },
        { account: ACCOUNTS.accountsReceivable, creditCents: input.amountCents },
      ],
    });

    const payment: Payment = { ...input, status: 'settled' };
    this.payments.set(payment.id, payment);
    return { ...payment };
  }

  get(id: string): Payment {
    const p = this.payments.get(id);
    if (!p) throw new PaymentError(`unknown payment: ${id}`);
    return { ...p };
  }
}
