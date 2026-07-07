// Multi-GAAP: the same underlying ledger events, presented under more than one
// accounting basis. Revenue recognition timing differs — cash basis recognizes
// at settlement, accrual at invoice issue. Views are derived, never a second
// source of writes (invariant 1: one event stream, many projections).

import type { Ledger, JournalLine } from './ledger.ts';

export type Basis = 'accrual' | 'cash';

export interface GaapView {
  basis: Basis;
  /** Recognized revenue by account, in cents. */
  revenue: Map<string, number>;
  totalRevenueCents: number;
}

const REVENUE_PREFIX = 'revenue:';

/**
 * Accrual recognizes revenue when the receivable is booked (invoice issue).
 * Cash recognizes proportionally to cash actually received against that
 * agreement. Both read the one ledger; neither writes.
 */
export function gaapView(ledger: Ledger, basis: Basis): GaapView {
  const revenue = new Map<string, number>();
  const lines = ledger.allLines;

  if (basis === 'accrual') {
    for (const l of lines) {
      if (l.account.startsWith(REVENUE_PREFIX)) {
        const recognized = l.creditCents - l.debitCents;
        revenue.set(l.account, (revenue.get(l.account) ?? 0) + recognized);
      }
    }
  } else {
    // Cash basis: scale each agreement's accrued revenue by the fraction of its
    // receivables actually collected. Collection is measured by CREDITS to
    // accounts_receivable (what payments post) against DEBITS to it (what
    // invoices post). Deposits move cash but never touch AR, so liability
    // inflows correctly do not count as revenue collection.
    const byAgreement = groupByAgreement(lines);
    for (const [, agLines] of byAgreement) {
      const accrued = sumRevenue(agLines);
      if (accrued.total === 0) continue;
      const arLines = agLines.filter((l) => l.account === 'assets:accounts_receivable');
      const billed = arLines.reduce((s, l) => s + l.debitCents, 0);
      const collected = arLines.reduce((s, l) => s + l.creditCents, 0);
      const ratio = billed > 0 ? Math.min(1, Math.max(0, collected / billed)) : 0;
      for (const [acct, amt] of accrued.byAccount) {
        revenue.set(acct, (revenue.get(acct) ?? 0) + Math.round(amt * ratio));
      }
    }
  }

  let totalRevenueCents = 0;
  for (const v of revenue.values()) totalRevenueCents += v;
  return { basis, revenue, totalRevenueCents };
}

function groupByAgreement(lines: readonly JournalLine[]): Map<string, JournalLine[]> {
  const m = new Map<string, JournalLine[]>();
  for (const l of lines) {
    const key = l.agreementId ?? '__none__';
    const arr = m.get(key) ?? [];
    arr.push(l);
    m.set(key, arr);
  }
  return m;
}

function sumRevenue(lines: readonly JournalLine[]): { total: number; byAccount: Map<string, number> } {
  const byAccount = new Map<string, number>();
  let total = 0;
  for (const l of lines) {
    if (l.account.startsWith(REVENUE_PREFIX)) {
      const recognized = l.creditCents - l.debitCents;
      byAccount.set(l.account, (byAccount.get(l.account) ?? 0) + recognized);
      total += recognized;
    }
  }
  return { total, byAccount };
}
