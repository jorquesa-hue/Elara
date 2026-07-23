// Property operating budgets — the plan a manager sets for a community so actuals
// can be monitored against it: budgeted revenue and expense line items over a
// period, from which NOI (net operating income) is planned. Actuals come from
// the ledger (revenue credits − debits, expense debits − credits scoped to the
// property); this module owns only the PLAN. Pure, zero-dependency, tenant-scoped.

export type BudgetCategory = 'revenue' | 'expense';

export interface BudgetLine {
  category: BudgetCategory;
  /** Human label, e.g. "Base rent", "Repairs & maintenance". */
  label: string;
  /** Optional GL account the line maps to (for actual matching by account). */
  account?: string;
  /** Planned amount for the period, in minor units (always non-negative). */
  amountCents: number;
}

export interface PropertyBudget {
  id: string;
  tenantId: string;
  propertyId: string;
  /** Inclusive ISO date. */
  periodStart: string;
  /** Exclusive ISO date. */
  periodEnd: string;
  currency: string;
  lines: BudgetLine[];
  notes?: string;
  createdAt: string;
}

export interface BudgetTotals {
  revenueCents: number;
  expenseCents: number;
  noiCents: number;
}

/** Actual + variance against a budget, given the ledger-derived actuals. */
export interface BudgetVsActual {
  budgeted: BudgetTotals;
  actual: BudgetTotals;
  /** actual − budgeted for each figure (positive = over plan). */
  variance: BudgetTotals;
  /** NOI ÷ revenue, as a percentage of the actual figures (0 when no revenue). */
  actualNoiMarginPct: number;
  budgetNoiMarginPct: number;
}

export class PropertyBudgetError extends Error {}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

/** Sum a budget's revenue, expense and the resulting NOI. */
export function budgetTotals(lines: readonly BudgetLine[]): BudgetTotals {
  let revenueCents = 0;
  let expenseCents = 0;
  for (const l of lines) {
    if (l.category === 'revenue') revenueCents += l.amountCents;
    else expenseCents += l.amountCents;
  }
  return { revenueCents, expenseCents, noiCents: revenueCents - expenseCents };
}

/** Fold budgeted + actual into a variance view. `actual` is computed elsewhere
 *  (from the ledger). Margins are NOI ÷ revenue in whole percent. */
export function budgetVsActual(lines: readonly BudgetLine[], actual: BudgetTotals): BudgetVsActual {
  const budgeted = budgetTotals(lines);
  const margin = (t: BudgetTotals) => (t.revenueCents > 0 ? Math.round((t.noiCents / t.revenueCents) * 1000) / 10 : 0);
  return {
    budgeted,
    actual,
    variance: {
      revenueCents: actual.revenueCents - budgeted.revenueCents,
      expenseCents: actual.expenseCents - budgeted.expenseCents,
      noiCents: actual.noiCents - budgeted.noiCents,
    },
    actualNoiMarginPct: margin(actual),
    budgetNoiMarginPct: margin(budgeted),
  };
}

function assertValid(b: PropertyBudget): void {
  if (!b.propertyId) throw new PropertyBudgetError('property budget requires a propertyId');
  if (!ISO_DATE.test(b.periodStart) || !ISO_DATE.test(b.periodEnd)) throw new PropertyBudgetError('period dates must be ISO dates');
  if (!(b.periodStart < b.periodEnd)) throw new PropertyBudgetError('periodStart must be before periodEnd');
  for (const l of b.lines) {
    if (l.category !== 'revenue' && l.category !== 'expense') throw new PropertyBudgetError(`invalid budget line category: ${l.category}`);
    if (!Number.isInteger(l.amountCents) || l.amountCents < 0) throw new PropertyBudgetError('budget line amountCents must be a non-negative integer');
    if (!l.label) throw new PropertyBudgetError('budget line requires a label');
  }
}

export class PropertyBudgets {
  private readonly byId = new Map<string, PropertyBudget>();

  create(b: PropertyBudget): PropertyBudget {
    if (this.byId.has(b.id)) throw new PropertyBudgetError(`property budget ${b.id} already exists`);
    assertValid(b);
    const rec: PropertyBudget = { ...b, lines: b.lines.map((l) => ({ ...l })) };
    this.byId.set(b.id, rec);
    return rec;
  }

  update(id: string, patch: Partial<Pick<PropertyBudget, 'lines' | 'notes' | 'periodStart' | 'periodEnd' | 'currency'>>): PropertyBudget {
    const cur = this.get(id);
    const next: PropertyBudget = {
      ...cur,
      ...(patch.periodStart !== undefined ? { periodStart: patch.periodStart } : {}),
      ...(patch.periodEnd !== undefined ? { periodEnd: patch.periodEnd } : {}),
      ...(patch.currency !== undefined ? { currency: patch.currency } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
      ...(patch.lines !== undefined ? { lines: patch.lines.map((l) => ({ ...l })) } : {}),
    };
    assertValid(next);
    this.byId.set(id, next);
    return next;
  }

  get(id: string): PropertyBudget {
    const b = this.byId.get(id);
    if (!b) throw new PropertyBudgetError(`property budget ${id} not found`);
    return b;
  }

  has(id: string): boolean { return this.byId.has(id); }

  list(tenantId: string): PropertyBudget[] {
    return [...this.byId.values()].filter((b) => b.tenantId === tenantId).sort((a, b) => (a.periodStart < b.periodStart ? 1 : -1));
  }

  forProperty(tenantId: string, propertyId: string): PropertyBudget[] {
    return this.list(tenantId).filter((b) => b.propertyId === propertyId);
  }

  /** Reload persisted budgets verbatim (no side effects). */
  hydrate(budgets: readonly PropertyBudget[]): void {
    for (const b of budgets) this.byId.set(b.id, { ...b, lines: b.lines.map((l) => ({ ...l })) });
  }

  all(): PropertyBudget[] { return [...this.byId.values()]; }
}
