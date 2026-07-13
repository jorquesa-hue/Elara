// Purchase orders & budgets (#2 — the accounting depth beyond AR/AP). A purchase
// order is a spending COMMITMENT, not a journal entry: raising a PO encumbers
// budget but posts nothing to the ledger (no expense is incurred until goods or
// services arrive and a bill is booked). So POs are deliberately GL-silent — the
// AP bill is what hits the ledger (invariant 6 stays with Payables). A budget is
// a planned figure per GL account and period; its status folds three numbers:
// budgeted (the plan), committed (open POs), and actual (posted bills) — the
// classic plan-vs-commitment-vs-actual variance view. All pure & zero-dep.

export interface PurchaseOrderLine {
  description: string;
  account: string; // the expense account this line will hit when billed
  amountCents: number;
}

export type PurchaseOrderStatus = 'draft' | 'approved' | 'received' | 'closed' | 'cancelled';

export interface PurchaseOrder {
  id: string;
  tenantId: string;
  vendorId: string; // party in the payee/vendor role
  entityId?: string; // purchasing legal entity
  createdAt: string;
  expectedAt?: string; // when delivery is expected — used to bucket the commitment into a budget period
  currency: string;
  lines: PurchaseOrderLine[];
  totalCents: number;
  status: PurchaseOrderStatus;
  billedCents: number; // AP billed against this PO so far
  approvedAt?: string;
  receivedAt?: string;
  closedAt?: string;
  cancelledAt?: string;
  memo?: string;
}

export interface Budget {
  id: string;
  tenantId: string;
  account: string; // the GL account this budget governs
  periodStart: string; // inclusive ISO date
  periodEnd: string; // exclusive ISO date
  amountCents: number;
  label?: string;
}

export interface BudgetStatus {
  budgetedCents: number;
  committedCents: number; // open PO commitments in the period
  actualCents: number; // posted bill spend in the period
  remainingCents: number; // budgeted − committed − actual
  usedPct: number; // (committed + actual) / budgeted, 0..100+ (one decimal)
  overBudget: boolean;
}

/** A single month's slice of a budget: the evenly-split budgeted figure vs the
 *  actual spend booked that month, with the variance. */
export interface BudgetMonthBucket {
  month: string; // YYYY-MM
  budgetedCents: number;
  actualCents: number;
  varianceCents: number; // budgeted − actual (positive = under budget)
  overBudget: boolean;
}

/** Enumerate the YYYY-MM months a [start, end) date window spans (end exclusive). */
export function monthsInWindow(start: string, end: string): string[] {
  const s = start.slice(0, 7), e = end.slice(0, 7);
  const [sy, sm] = s.split('-').map((n) => parseInt(n, 10));
  const [ey, em] = e.split('-').map((n) => parseInt(n, 10));
  if (!sy || !sm || !ey || !em) return [];
  const out: string[] = [];
  let y = sy, m = sm;
  // end is exclusive: the end month is included only if end is past its first day.
  const endExclusiveDay = end.slice(8, 10);
  const includeEndMonth = endExclusiveDay !== '01' && endExclusiveDay !== '';
  while (y < ey || (y === ey && (m < em || (m === em && includeEndMonth)))) {
    out.push(`${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

/** Split a budget evenly across the months it spans and bucket actuals by month.
 *  The even split carries its rounding remainder onto the LAST month so the
 *  monthly budgeted figures sum back to exactly the period total. Pure. */
export function monthlyBudgetBuckets(budget: Budget, actualByMonth: ReadonlyMap<string, number>): BudgetMonthBucket[] {
  const months = monthsInWindow(budget.periodStart, budget.periodEnd);
  if (months.length === 0) return [];
  const per = Math.floor(budget.amountCents / months.length);
  const remainder = budget.amountCents - per * months.length;
  return months.map((month, i) => {
    const budgetedCents = per + (i === months.length - 1 ? remainder : 0);
    const actualCents = actualByMonth.get(month) ?? 0;
    return { month, budgetedCents, actualCents, varianceCents: budgetedCents - actualCents, overBudget: actualCents > budgetedCents };
  });
}

export class ProcurementError extends Error {}

// A PO holds a commitment while approved or received; draft is not yet committed,
// closed/cancelled release it.
const COMMITTING: ReadonlySet<PurchaseOrderStatus> = new Set(['approved', 'received']);

/** Pure: fold a budget and its committed/actual figures into a status. */
export function computeBudgetStatus(budget: Budget, committedCents: number, actualCents: number): BudgetStatus {
  const remainingCents = budget.amountCents - committedCents - actualCents;
  const used = committedCents + actualCents;
  return {
    budgetedCents: budget.amountCents,
    committedCents,
    actualCents,
    remainingCents,
    usedPct: budget.amountCents > 0 ? Math.round((used / budget.amountCents) * 1000) / 10 : 0,
    overBudget: used > budget.amountCents,
  };
}

export class Procurement {
  private pos = new Map<string, PurchaseOrder>();
  private budgets = new Map<string, Budget>();

  /** Load stored purchase orders + budgets for cold-start rehydration. */
  hydrate(pos: readonly PurchaseOrder[], budgets: readonly Budget[]): void {
    for (const po of pos) this.pos.set(po.id, { ...po, lines: po.lines.map((l) => ({ ...l })) });
    for (const b of budgets) this.budgets.set(b.id, { ...b });
  }

  // --- purchase orders -----------------------------------------------------

  /** Raise a PO in draft. Encumbers nothing until approved. */
  raise(input: {
    id: string;
    tenantId: string;
    vendorId: string;
    entityId?: string;
    createdAt: string;
    expectedAt?: string;
    currency?: string;
    lines: PurchaseOrderLine[];
    memo?: string;
  }): PurchaseOrder {
    if (this.pos.has(input.id)) throw new ProcurementError(`duplicate purchase order: ${input.id}`);
    if (input.lines.length === 0) throw new ProcurementError(`purchase order ${input.id} has no lines`);
    const totalCents = input.lines.reduce((s, l) => s + l.amountCents, 0);
    if (totalCents <= 0) throw new ProcurementError(`purchase order ${input.id} total must be positive`);
    for (const l of input.lines) {
      if (!Number.isInteger(l.amountCents) || l.amountCents <= 0) throw new ProcurementError(`purchase order ${input.id}: line amounts must be positive integers`);
    }
    const po: PurchaseOrder = {
      id: input.id,
      tenantId: input.tenantId,
      vendorId: input.vendorId,
      entityId: input.entityId,
      createdAt: input.createdAt,
      expectedAt: input.expectedAt,
      currency: input.currency ?? 'BRL',
      lines: input.lines.map((l) => ({ ...l })),
      totalCents,
      status: 'draft',
      billedCents: 0,
      memo: input.memo,
    };
    this.pos.set(po.id, po);
    return this.get(po.id);
  }

  get(id: string): PurchaseOrder {
    const po = this.pos.get(id);
    if (!po) throw new ProcurementError(`unknown purchase order: ${id}`);
    return { ...po, lines: po.lines.map((l) => ({ ...l })) };
  }

  approve(id: string, at: string): PurchaseOrder {
    const po = this.mutable(id);
    if (po.status !== 'draft') throw new ProcurementError(`purchase order ${id} is ${po.status}; only a draft can be approved`);
    po.status = 'approved';
    po.approvedAt = at;
    return this.get(id);
  }

  receive(id: string, at: string): PurchaseOrder {
    const po = this.mutable(id);
    if (po.status !== 'approved') throw new ProcurementError(`purchase order ${id} is ${po.status}; only an approved PO can be received`);
    po.status = 'received';
    po.receivedAt = at;
    return this.get(id);
  }

  close(id: string, at: string): PurchaseOrder {
    const po = this.mutable(id);
    if (po.status !== 'approved' && po.status !== 'received') throw new ProcurementError(`purchase order ${id} is ${po.status}; cannot close`);
    po.status = 'closed';
    po.closedAt = at;
    return this.get(id);
  }

  cancel(id: string, at: string): PurchaseOrder {
    const po = this.mutable(id);
    if (po.status === 'closed' || po.status === 'cancelled') throw new ProcurementError(`purchase order ${id} is ${po.status}; cannot cancel`);
    if (po.billedCents > 0) throw new ProcurementError(`purchase order ${id} has been billed; cannot cancel`);
    po.status = 'cancelled';
    po.cancelledAt = at;
    return this.get(id);
  }

  /** Pure pre-check: would recordBilling(id, amountCents) succeed right now?
   *  Lets a caller validate BEFORE posting the bill's GL entry, so a bill+PO
   *  request is atomic (never a booked bill whose PO accrual then fails). */
  assertCanBill(id: string, amountCents: number): void {
    const po = this.mutable(id);
    if (po.status !== 'approved' && po.status !== 'received') throw new ProcurementError(`purchase order ${id} is ${po.status}; cannot bill against it`);
    if (amountCents <= 0) throw new ProcurementError('billed amount must be positive');
    if (po.billedCents + amountCents > po.totalCents) throw new ProcurementError(`billing would exceed purchase order ${id} total`);
  }

  /** Record that AP billed `amountCents` against this PO. When fully billed the
   *  PO auto-closes (its commitment is now an actual). */
  recordBilling(id: string, amountCents: number, at: string): PurchaseOrder {
    this.assertCanBill(id, amountCents);
    const po = this.mutable(id);
    po.billedCents += amountCents;
    if (po.billedCents === po.totalCents) { po.status = 'closed'; po.closedAt = at; }
    return this.get(id);
  }

  list(tenantId: string): PurchaseOrder[] {
    return [...this.pos.values()].filter((p) => p.tenantId === tenantId).map((p) => this.get(p.id));
  }

  /** Open PO commitment for an account within [start, end), bucketed by
   *  expectedAt (falling back to createdAt). Only approved/received POs commit. */
  committedForAccount(tenantId: string, account: string, start: string, end: string): number {
    let sum = 0;
    for (const po of this.pos.values()) {
      if (po.tenantId !== tenantId || !COMMITTING.has(po.status)) continue;
      const at = po.expectedAt ?? po.createdAt;
      if (at < start || at >= end) continue;
      for (const l of po.lines) if (l.account === account) sum += l.amountCents;
    }
    return sum;
  }

  // --- budgets -------------------------------------------------------------

  setBudget(budget: Budget): Budget {
    if (!budget.id || !budget.account) throw new ProcurementError('budget needs an id and an account');
    if (!Number.isInteger(budget.amountCents) || budget.amountCents < 0) throw new ProcurementError(`budget ${budget.id}: amountCents must be a non-negative integer`);
    if (!(budget.periodStart < budget.periodEnd)) throw new ProcurementError(`budget ${budget.id}: periodStart must be before periodEnd`);
    this.budgets.set(budget.id, { ...budget });
    return { ...budget };
  }

  getBudget(tenantId: string, id: string): Budget | null {
    const b = this.budgets.get(id);
    return b && b.tenantId === tenantId ? { ...b } : null;
  }

  listBudgets(tenantId: string): Budget[] {
    return [...this.budgets.values()].filter((b) => b.tenantId === tenantId).map((b) => ({ ...b }));
  }

  private mutable(id: string): PurchaseOrder {
    const po = this.pos.get(id);
    if (!po) throw new ProcurementError(`unknown purchase order: ${id}`);
    return po;
  }
}
