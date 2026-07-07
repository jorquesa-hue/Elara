// Billing: issues invoices and posts the matching receivable/revenue entry.
// Every invoice mutation flows through the ledger, so journal balance
// (invariant 6) covers billing by construction.

import { Ledger } from './ledger.ts';

export interface InvoiceLine {
  description: string;
  account: string; // revenue account credited
  amountCents: number;
}

export type InvoiceStatus = 'open' | 'partially_paid' | 'paid' | 'void';

export interface Invoice {
  id: string;
  agreementId: string;
  tenantId: string;
  issuedAt: string;
  dueAt: string;
  currency: string;
  lines: InvoiceLine[];
  totalCents: number;
  paidCents: number;
  status: InvoiceStatus;
}

export class BillingError extends Error {}

export const ACCOUNTS = {
  cash: 'assets:cash',
  accountsReceivable: 'assets:accounts_receivable',
  accountsPayable: 'liabilities:accounts_payable',
  depositsHeld: 'liabilities:deposits_held',
  roomRevenue: 'revenue:room',
  amenityRevenue: 'revenue:amenity',
  lateFeeRevenue: 'revenue:late_fee',
  deductionRevenue: 'revenue:deposit_deductions',
  supplierExpense: 'expenses:supplier',
} as const;

export class Billing {
  private invoices = new Map<string, Invoice>();

  constructor(private readonly ledger: Ledger) {}

  issue(input: {
    id: string;
    agreementId: string;
    tenantId: string;
    issuedAt: string;
    dueAt: string;
    currency?: string;
    lines: InvoiceLine[];
  }): Invoice {
    if (this.invoices.has(input.id)) throw new BillingError(`duplicate invoice: ${input.id}`);
    if (input.lines.length === 0) throw new BillingError(`invoice ${input.id} has no lines`);
    const totalCents = input.lines.reduce((s, l) => s + l.amountCents, 0);
    if (totalCents <= 0) throw new BillingError(`invoice ${input.id} total must be positive`);

    const invoice: Invoice = {
      id: input.id,
      agreementId: input.agreementId,
      tenantId: input.tenantId,
      issuedAt: input.issuedAt,
      dueAt: input.dueAt,
      currency: input.currency ?? 'BRL',
      lines: input.lines.map((l) => ({ ...l })),
      totalCents,
      paidCents: 0,
      status: 'open',
    };

    this.ledger.post({
      entryId: `je-${input.id}`,
      postedAt: input.issuedAt,
      currency: invoice.currency,
      agreementId: input.agreementId,
      memo: `invoice ${input.id}`,
      lines: [
        { account: ACCOUNTS.accountsReceivable, debitCents: totalCents },
        ...input.lines.map((l) => ({
          account: l.account,
          creditCents: l.amountCents,
          memo: l.description,
        })),
      ],
    });

    this.invoices.set(invoice.id, invoice);
    return { ...invoice, lines: invoice.lines.map((l) => ({ ...l })) };
  }

  get(id: string): Invoice {
    const inv = this.invoices.get(id);
    if (!inv) throw new BillingError(`unknown invoice: ${id}`);
    return { ...inv, lines: inv.lines.map((l) => ({ ...l })) };
  }

  /** Called by Payments when cash is applied. */
  applyPayment(invoiceId: string, amountCents: number): Invoice {
    const inv = this.invoices.get(invoiceId);
    if (!inv) throw new BillingError(`unknown invoice: ${invoiceId}`);
    if (inv.status === 'void' || inv.status === 'paid') {
      throw new BillingError(`invoice ${invoiceId} is ${inv.status}; cannot apply payment`);
    }
    if (amountCents <= 0) throw new BillingError('payment amount must be positive');
    if (inv.paidCents + amountCents > inv.totalCents) {
      throw new BillingError(`payment would overpay invoice ${invoiceId}`);
    }
    inv.paidCents += amountCents;
    inv.status = inv.paidCents === inv.totalCents ? 'paid' : 'partially_paid';
    return this.get(invoiceId);
  }

  openInvoices(): readonly Invoice[] {
    return [...this.invoices.values()]
      .filter((i) => i.status === 'open' || i.status === 'partially_paid')
      .map((i) => this.get(i.id));
  }

  allInvoices(): readonly Invoice[] {
    return [...this.invoices.values()].map((i) => this.get(i.id));
  }
}
