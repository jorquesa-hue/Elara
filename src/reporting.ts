// Reporting & insights — the self-service analytics layer. A pure, zero-dependency
// engine that (a) builds a CATALOG of reports over a tenant's own data for a chosen
// window (occupancy, revenue/ADR/RevPAR, AR aging, collections, deposits, payables,
// pipeline, portfolio, cashflow) and (b) derives AUTOMATED INSIGHTS — prioritized,
// explainable findings ("R$X across N invoices are >30 days overdue → run a
// collections sweep", "occupancy 31% is low", "weekend ADR is below your floor").
//
// The intelligence is deterministic and auditable: every insight states the metric
// it fired on and the action to take, so an operator can trust it and an LLM can
// later narrate a summary over the same structured findings (the seam).

export interface ReportingInput {
  now: string; // ISO instant
  from: string; // window start, ISO date (YYYY-MM-DD)
  to: string; // window end, ISO date (exclusive)
  currency: string;
  units: ReadonlyArray<{ id: string; label: string; active: boolean; typeName?: string; propertyId?: string; propertyName?: string }>;
  /** Properties/communities for owner statements (labels + owning entity). */
  properties?: ReadonlyArray<{ id: string; name: string; entityName?: string }>;
  /** residentName: resolved by the App (party role link, else master-data guest). */
  agreements: ReadonlyArray<{ id: string; kind: string; status: string; unitId: string; start: string; end: string; rateCents: number; residentName?: string }>;
  invoices: ReadonlyArray<{ id: string; agreementId: string; issuedAt: string; dueAt: string; totalCents: number; paidCents: number; status: string }>;
  payments: ReadonlyArray<{ id: string; invoiceId: string; amountCents: number; receivedAt: string; status: string }>;
  deposits: ReadonlyArray<{ id: string; agreementId: string; amountCents: number; status: string; heldAt: string; refundedCents?: number | null }>;
  bills: ReadonlyArray<{ id: string; payeeId: string; totalCents: number; paidCents: number; status: string; issuedAt: string; dueAt: string }>;
  apPayments: ReadonlyArray<{ id: string; billId: string; amountCents: number; paidAt: string; status: string }>;
  leads: ReadonlyArray<{ id: string; stage: string; estValueCents: number; createdAt: string; updatedAt: string; source?: string }>;
  workOrders: ReadonlyArray<{ id: string; status: string; priority: string; openedAt: string; title?: string }>;
  /** Unit turns (make-ready) — for the turn-time report + insight. days = vacate→ready (or →now). */
  turns?: ReadonlyArray<{ id: string; unitLabel: string; status: string; days: number; openTasks: number }>;
  /** Renters-insurance policies — for the compliance report + lapsed-coverage insight. */
  insurancePolicies?: ReadonlyArray<{ agreementId: string; carrier: string; liabilityCents: number; effectiveAt: string; expiresAt: string; status: string }>;
  /** Parcels at the front desk — for the package-room report + aging insight. */
  parcels?: ReadonlyArray<{ recipientName: string; unitLabel?: string; carrier: string; status: string; daysWaiting: number }>;
  /** Waitlist entries — for the demand-by-floorplan report + demand insight. */
  waitlist?: ReadonlyArray<{ floorplanName?: string; status: string }>;
  /** Owner distributions — for the distributions-by-owner report. */
  distributions?: ReadonlyArray<{ entityName: string; propertyName?: string; amountCents: number; recordedAt: string }>;
  /** Owner capital contributions — for the capital-account report. */
  contributions?: ReadonlyArray<{ entityName: string; amountCents: number }>;
  holds: ReadonlyArray<{ unitId: string; start: string; end: string; status: string }>;
  ledgerBalanced: boolean;
  /** Tenant-scoped journal lines — the raw material for the FINANCIAL reports
   *  (income statement, general ledger). Optional for backward compatibility. */
  ledgerLines?: ReadonlyArray<{ account: string; debitCents: number; creditCents: number; postedAt: string; entryId?: string; entityId?: string; propertyId?: string }>;
  propertyBudgets?: ReadonlyArray<{ propertyId: string; propertyName?: string; periodStart: string; periodEnd: string; budgetRevenueCents: number; budgetExpenseCents: number }>;
}

export interface ReportColumn { key: string; label: string; kind?: 'money' | 'number' | 'percent' | 'text' | 'date' }
export interface Report {
  key: string;
  title: string;
  subtitle?: string;
  window: { from: string; to: string };
  columns: ReportColumn[];
  rows: Array<Record<string, unknown>>;
  /** Headline figures for stat tiles. */
  kpis: Array<{ label: string; value: number; kind: 'money' | 'number' | 'percent'; delta?: number }>;
}

export type InsightSeverity = 'critical' | 'warning' | 'info' | 'positive';
export interface Insight {
  severity: InsightSeverity;
  title: string;
  detail: string;
  /** Optional headline number the finding is about (for display). */
  metric?: { value: number; kind: 'money' | 'number' | 'percent' };
  /** A concrete next step, when there is one. */
  action?: string;
  /** Stable code so the UI can translate title/detail/action (with the English
   *  strings above as the fallback). */
  code?: string;
  /** Stable i18n keys, derived from `code`, for each translatable part — the
   *  portal renders tt(titleKey) + interpolate(params), falling back to the
   *  English title/detail/action above. */
  titleKey?: string;
  messageKey?: string;
  actionKey?: string;
  /** Interpolation values for the translated strings (e.g. {n}, {occ}). */
  params?: Record<string, string | number>;
}

export interface ReportSpec { key: string; title: string; description: string }
export const REPORT_CATALOG: readonly ReportSpec[] = [
  // The property-management staples (the RealPage/Entrata-class operational set).
  { key: 'rent_roll', title: 'Rent roll', description: 'Every unit with its resident, lease dates, scheduled rent, deposit held and outstanding balance — plus occupancy and scheduled-rent totals.' },
  { key: 'delinquency', title: 'Delinquency (aged)', description: 'Aged receivables by resident: current, 1–30, 31–60, 61–90 and 90+ day buckets per account.' },
  { key: 'income_statement', title: 'Income statement', description: 'Revenue and expenses from the ledger for the window — the P&L, with net operating income.' },
  { key: 'balance_sheet', title: 'Balance sheet', description: 'Financial position as of the window end — assets, liabilities and equity (with current earnings).' },
  { key: 'trailing_twelve', title: 'Trailing 12 months (T-12)', description: 'Month-by-month revenue, expenses and NOI over the trailing twelve months — the standard underwriting statement.' },
  { key: 'pnl_comparison', title: 'P&L — period comparison', description: 'Revenue, expenses and NOI this period vs the prior period, with variance.' },
  { key: 'owner_statement', title: 'Owner statement', description: 'Net operating income by property/community with the owning legal entity — the fund/owner report.' },
  { key: 'property_budget', title: 'Budget vs actual (NOI)', description: 'Planned vs actual net operating income per community, from the operating budgets and the ledger.' },
  { key: 'billing_collections', title: 'Billed vs collected', description: 'Invoiced vs cash collected by month, with the collection rate.' },
  { key: 'lease_expirations', title: 'Lease expirations', description: 'Active leases bucketed by expiration month — the renewal-exposure schedule.' },
  { key: 'box_score', title: 'Box score', description: 'Leasing activity for the window: move-ins, move-outs, funnel counts and occupancy.' },
  { key: 'vacancy', title: 'Vacancy & availability', description: 'Vacant units with days vacant, last occupancy and rent at risk.' },
  { key: 'occupancy', title: 'Occupancy', description: 'Sold vs available room-nights per unit for the window.' },
  { key: 'occupancy_trend', title: 'Occupancy trend', description: 'Portfolio occupancy month by month.' },
  { key: 'revenue', title: 'Revenue & ADR', description: 'Cash collected, ADR and RevPAR, by month.' },
  { key: 'ar_aging', title: 'Receivables aging', description: 'Outstanding invoices bucketed by days overdue.' },
  { key: 'collections', title: 'Collections', description: 'Every past-due invoice with days overdue and outstanding balance.' },
  { key: 'deposits', title: 'Security deposits', description: 'Held vs refunded, and current exposure.' },
  { key: 'payables', title: 'Accounts payable', description: 'Vendor bills outstanding, aged by due date.' },
  { key: 'wo_aging', title: 'Work-order aging', description: 'Open work orders by age and priority.' },
  { key: 'make_ready', title: 'Make-ready (turn time)', description: 'Unit turns with days-in-turn and the turn-time KPIs — how fast vacant units get rent-ready.' },
  { key: 'insurance_compliance', title: 'Insurance compliance', description: 'Renters-insurance coverage per active lease — compliant, expiring, lapsed or none, with the portfolio compliance rate.' },
  { key: 'package_room', title: 'Package room', description: 'Parcels awaiting pickup at the front desk, by days waiting — the packages still clogging the mail room.' },
  { key: 'waitlist_demand', title: 'Waitlist demand', description: 'Prospects waiting per floorplan — where demand outstrips available supply.' },
  { key: 'owner_distributions', title: 'Owner distributions', description: 'Cash distributions (equity draws) paid to each owning entity/community in the window — the capital returned to owners.' },
  { key: 'capital_account', title: 'Capital accounts', description: 'Per owning entity: capital contributed in, distributions paid out, and net invested — the investor capital account.' },
  { key: 'pipeline', title: 'Sales pipeline', description: 'Leads by stage, pipeline value and conversion.' },
  { key: 'portfolio', title: 'Portfolio mix', description: 'Agreements by kind and status; unit occupancy mix.' },
  { key: 'cashflow', title: 'Cash flow', description: 'Money in (payments) vs money out (vendor payouts) for the window.' },
  { key: 'general_ledger', title: 'General ledger', description: 'Every account with its debits, credits and running balance — the books.' },
  { key: 'cash_flow_statement', title: 'Statement of cash flows', description: 'Opening → closing cash, with movement classified into operating, investing and financing activities.' },
];

// --- date helpers -----------------------------------------------------------
const DAY = 86_400_000;
const ms = (d: string) => Date.parse(d);
function daysBetween(a: string, b: string): number { return Math.max(0, Math.round((ms(b) - ms(a)) / DAY)); }
function overlapNights(s1: string, e1: string, s2: string, e2: string): number {
  const s = Math.max(ms(s1), ms(s2)), e = Math.min(ms(e1), ms(e2));
  return e > s ? Math.round((e - s) / DAY) : 0;
}
function inWindow(d: string, from: string, to: string): boolean { const t = ms(d); return t >= ms(from) && t < ms(to); }
function monthKey(d: string): string { return d.slice(0, 7); }
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const outstanding = (i: { totalCents: number; paidCents: number }) => Math.max(0, i.totalCents - i.paidCents);
const OPEN_INV = new Set(['open', 'partially_paid']);

/** The window immediately before [from,to) of the same length — for trends. */
function priorWindow(from: string, to: string): { from: string; to: string } {
  const span = ms(to) - ms(from);
  return { from: new Date(ms(from) - span).toISOString().slice(0, 10), to: from };
}
function pct(n: number, d: number): number { return d > 0 ? Math.round((n / d) * 1000) / 10 : 0; }

// --- report builders --------------------------------------------------------

function occupancy(inp: ReportingInput): Report {
  const nights = daysBetween(inp.from, inp.to);
  const active = inp.holds.filter((h) => h.status === 'active');
  const rows = inp.units.map((u) => {
    const sold = sum(active.filter((h) => h.unitId === u.id).map((h) => overlapNights(h.start, h.end, inp.from, inp.to)));
    return { unit: u.label, available: nights, sold, occupancy: pct(sold, nights) };
  }).sort((a, b) => b.occupancy - a.occupancy);
  const totalSold = sum(rows.map((r) => r.sold as number));
  const totalAvail = nights * inp.units.length;
  return {
    key: 'occupancy', title: 'Occupancy', window: { from: inp.from, to: inp.to },
    columns: [
      { key: 'unit', label: 'Unit', kind: 'text' }, { key: 'available', label: 'Available nights', kind: 'number' },
      { key: 'sold', label: 'Sold nights', kind: 'number' }, { key: 'occupancy', label: 'Occupancy', kind: 'percent' },
    ],
    rows,
    kpis: [
      { label: 'Occupancy', value: pct(totalSold, totalAvail), kind: 'percent' },
      { label: 'Sold room-nights', value: totalSold, kind: 'number' },
      { label: 'Available room-nights', value: totalAvail, kind: 'number' },
    ],
  };
}

function revenue(inp: ReportingInput): Report {
  const settled = inp.payments.filter((p) => p.status !== 'void');
  const win = settled.filter((p) => inWindow(p.receivedAt, inp.from, inp.to));
  const byMonth = new Map<string, number>();
  for (const p of win) byMonth.set(monthKey(p.receivedAt), (byMonth.get(monthKey(p.receivedAt)) ?? 0) + p.amountCents);
  const rows = [...byMonth.entries()].sort().map(([month, cents]) => ({ month, revenue: cents }));
  const total = sum(win.map((p) => p.amountCents));
  // Sold nights & available for ADR/RevPAR.
  const nights = daysBetween(inp.from, inp.to);
  const sold = sum(inp.holds.filter((h) => h.status === 'active').map((h) => overlapNights(h.start, h.end, inp.from, inp.to)));
  const avail = nights * Math.max(1, inp.units.length);
  const prev = priorWindow(inp.from, inp.to);
  const prevTotal = sum(settled.filter((p) => inWindow(p.receivedAt, prev.from, prev.to)).map((p) => p.amountCents));
  return {
    key: 'revenue', title: 'Revenue & ADR', window: { from: inp.from, to: inp.to },
    subtitle: 'Cash basis — payments received in the window.',
    columns: [{ key: 'month', label: 'Month', kind: 'text' }, { key: 'revenue', label: 'Revenue', kind: 'money' }],
    rows,
    kpis: [
      { label: 'Revenue', value: total, kind: 'money', delta: prevTotal > 0 ? pct(total - prevTotal, prevTotal) : undefined },
      { label: 'ADR', value: sold > 0 ? Math.round(total / sold) : 0, kind: 'money' },
      { label: 'RevPAR', value: avail > 0 ? Math.round(total / avail) : 0, kind: 'money' },
    ],
  };
}

const AGING_BUCKETS = [
  { key: 'current', label: 'Not yet due', min: -1e9, max: 0 },
  { key: 'd1_30', label: '1–30 days', min: 1, max: 30 },
  { key: 'd31_60', label: '31–60 days', min: 31, max: 60 },
  { key: 'd61_90', label: '61–90 days', min: 61, max: 90 },
  { key: 'd90', label: '90+ days', min: 91, max: 1e9 },
];
function arAging(inp: ReportingInput): Report {
  const open = inp.invoices.filter((i) => OPEN_INV.has(i.status) && outstanding(i) > 0);
  const rows = AGING_BUCKETS.map((b) => {
    const inB = open.filter((i) => { const d = daysBetween(i.dueAt, inp.now); return (ms(i.dueAt) > ms(inp.now) ? 0 : d) >= b.min && (ms(i.dueAt) > ms(inp.now) ? 0 : d) <= b.max; });
    return { bucket: b.label, count: inB.length, outstanding: sum(inB.map(outstanding)) };
  });
  const total = sum(open.map(outstanding));
  const overdue = sum(open.filter((i) => ms(i.dueAt) < ms(inp.now)).map(outstanding));
  return {
    key: 'ar_aging', title: 'Receivables aging', window: { from: inp.from, to: inp.to },
    columns: [{ key: 'bucket', label: 'Age', kind: 'text' }, { key: 'count', label: 'Invoices', kind: 'number' }, { key: 'outstanding', label: 'Outstanding', kind: 'money' }],
    rows,
    kpis: [{ label: 'Total receivable', value: total, kind: 'money' }, { label: 'Overdue', value: overdue, kind: 'money' }, { label: 'Open invoices', value: open.length, kind: 'number' }],
  };
}

function collections(inp: ReportingInput): Report {
  const overdue = inp.invoices
    .filter((i) => OPEN_INV.has(i.status) && outstanding(i) > 0 && ms(i.dueAt) < ms(inp.now))
    .map((i) => ({ invoice: i.id, dueAt: i.dueAt.slice(0, 10), daysOverdue: daysBetween(i.dueAt, inp.now), outstanding: outstanding(i) }))
    .sort((a, b) => b.daysOverdue - a.daysOverdue);
  return {
    key: 'collections', title: 'Collections', window: { from: inp.from, to: inp.to },
    columns: [{ key: 'invoice', label: 'Invoice', kind: 'text' }, { key: 'dueAt', label: 'Due', kind: 'date' }, { key: 'daysOverdue', label: 'Days overdue', kind: 'number' }, { key: 'outstanding', label: 'Outstanding', kind: 'money' }],
    rows: overdue,
    kpis: [{ label: 'Overdue invoices', value: overdue.length, kind: 'number' }, { label: 'Overdue amount', value: sum(overdue.map((r) => r.outstanding)), kind: 'money' }],
  };
}

function depositsReport(inp: ReportingInput): Report {
  const held = inp.deposits.filter((d) => d.status === 'held');
  const refunded = inp.deposits.filter((d) => d.status === 'refunded');
  const rows = [
    { state: 'Held (active exposure)', count: held.length, amount: sum(held.map((d) => d.amountCents)) },
    { state: 'Refunded', count: refunded.length, amount: sum(refunded.map((d) => d.refundedCents ?? 0)) },
  ];
  return {
    key: 'deposits', title: 'Security deposits', window: { from: inp.from, to: inp.to },
    columns: [{ key: 'state', label: 'State', kind: 'text' }, { key: 'count', label: 'Count', kind: 'number' }, { key: 'amount', label: 'Amount', kind: 'money' }],
    rows,
    kpis: [{ label: 'Held exposure', value: sum(held.map((d) => d.amountCents)), kind: 'money' }, { label: 'Active deposits', value: held.length, kind: 'number' }],
  };
}

function payables(inp: ReportingInput): Report {
  const open = inp.bills.filter((b) => b.status !== 'void' && outstanding(b) > 0);
  const rows = AGING_BUCKETS.map((bk) => {
    const inB = open.filter((b) => { const overdueDays = ms(b.dueAt) > ms(inp.now) ? 0 : daysBetween(b.dueAt, inp.now); return overdueDays >= bk.min && overdueDays <= bk.max; });
    return { bucket: bk.label, count: inB.length, outstanding: sum(inB.map(outstanding)) };
  });
  return {
    key: 'payables', title: 'Accounts payable', window: { from: inp.from, to: inp.to },
    columns: [{ key: 'bucket', label: 'Age', kind: 'text' }, { key: 'count', label: 'Bills', kind: 'number' }, { key: 'outstanding', label: 'Outstanding', kind: 'money' }],
    rows,
    kpis: [{ label: 'Payable total', value: sum(open.map(outstanding)), kind: 'money' }, { label: 'Open bills', value: open.length, kind: 'number' }],
  };
}

const PIPELINE_STAGES = ['new', 'toured', 'applied', 'approved', 'signed'];
function pipeline(inp: ReportingInput): Report {
  const rows = PIPELINE_STAGES.map((stage) => {
    const inS = inp.leads.filter((l) => l.stage === stage);
    return { stage, count: inS.length, value: sum(inS.map((l) => l.estValueCents)) };
  });
  const lost = inp.leads.filter((l) => l.stage === 'lost');
  const won = inp.leads.filter((l) => l.stage === 'signed');
  const open = inp.leads.filter((l) => !['signed', 'lost'].includes(l.stage));
  return {
    key: 'pipeline', title: 'Sales pipeline', window: { from: inp.from, to: inp.to },
    columns: [{ key: 'stage', label: 'Stage', kind: 'text' }, { key: 'count', label: 'Leads', kind: 'number' }, { key: 'value', label: 'Est. value', kind: 'money' }],
    rows,
    kpis: [
      { label: 'Open pipeline', value: sum(open.map((l) => l.estValueCents)), kind: 'money' },
      { label: 'Won value', value: sum(won.map((l) => l.estValueCents)), kind: 'money' },
      { label: 'Conversion', value: pct(won.length, won.length + lost.length), kind: 'percent' },
    ],
  };
}

function portfolio(inp: ReportingInput): Report {
  const byKind = new Map<string, number>();
  const byStatus = new Map<string, number>();
  for (const a of inp.agreements) { byKind.set(a.kind, (byKind.get(a.kind) ?? 0) + 1); byStatus.set(a.status, (byStatus.get(a.status) ?? 0) + 1); }
  const rows = [...byKind.entries()].map(([kind, count]) => ({ segment: kind, count }));
  const active = inp.holds.filter((h) => h.status === 'active');
  const occupied = new Set(active.filter((h) => overlapNights(h.start, h.end, inp.from, inp.to) > 0).map((h) => h.unitId));
  return {
    key: 'portfolio', title: 'Portfolio mix', window: { from: inp.from, to: inp.to },
    subtitle: [...byStatus.entries()].map(([s, n]) => `${n} ${s}`).join(' · '),
    columns: [{ key: 'segment', label: 'Agreement kind', kind: 'text' }, { key: 'count', label: 'Count', kind: 'number' }],
    rows,
    kpis: [
      { label: 'Units', value: inp.units.length, kind: 'number' },
      { label: 'Occupied units', value: occupied.size, kind: 'number' },
      { label: 'Agreements', value: inp.agreements.length, kind: 'number' },
    ],
  };
}

function cashflow(inp: ReportingInput): Report {
  const inCents = sum(inp.payments.filter((p) => p.status !== 'void' && inWindow(p.receivedAt, inp.from, inp.to)).map((p) => p.amountCents));
  const outCents = sum(inp.apPayments.filter((p) => p.status !== 'void' && inWindow(p.paidAt, inp.from, inp.to)).map((p) => p.amountCents));
  return {
    key: 'cashflow', title: 'Cash flow', window: { from: inp.from, to: inp.to },
    columns: [{ key: 'flow', label: 'Flow', kind: 'text' }, { key: 'amount', label: 'Amount', kind: 'money' }],
    rows: [{ flow: 'Money in (payments)', amount: inCents }, { flow: 'Money out (vendor payouts)', amount: -outCents }, { flow: 'Net', amount: inCents - outCents }],
    kpis: [{ label: 'Money in', value: inCents, kind: 'money' }, { label: 'Money out', value: outCents, kind: 'money' }, { label: 'Net cash', value: inCents - outCents, kind: 'money' }],
  };
}

// --- property-management staples (the RealPage/Entrata-class set) -----------

/** The agreement currently occupying each unit: active AND its period contains
 *  today. When two qualify (shouldn't happen — the calendar prevents overlap),
 *  the later start wins. */
function currentAgreementByUnit(inp: ReportingInput): Map<string, ReportingInput['agreements'][number]> {
  const today = inp.now.slice(0, 10);
  const map = new Map<string, ReportingInput['agreements'][number]>();
  for (const a of inp.agreements) {
    if (a.status !== 'active') continue;
    if (a.start.slice(0, 10) <= today && today < a.end.slice(0, 10)) {
      const prev = map.get(a.unitId);
      if (!prev || a.start > prev.start) map.set(a.unitId, a);
    }
  }
  return map;
}
function sumByAgreement<T extends { agreementId: string }>(rows: readonly T[], amount: (r: T) => number): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.agreementId, (m.get(r.agreementId) ?? 0) + amount(r));
  return m;
}

function rentRoll(inp: ReportingInput): Report {
  const occ = currentAgreementByUnit(inp);
  const balance = sumByAgreement(inp.invoices.filter((i) => OPEN_INV.has(i.status)), outstanding);
  const heldDeposits = sumByAgreement(inp.deposits.filter((d) => d.status === 'held'), (d) => d.amountCents);
  const rows = inp.units
    .map((u) => {
      const a = occ.get(u.id);
      return {
        unit: u.label,
        property: u.propertyName ?? '',
        floorplan: u.typeName ?? '',
        status: a ? 'occupied' : u.active ? 'vacant' : 'offline',
        resident: a ? (a.residentName ?? '—') : '',
        kind: a?.kind ?? '',
        leaseStart: a ? a.start.slice(0, 10) : '',
        leaseEnd: a ? a.end.slice(0, 10) : '',
        rent: a?.rateCents ?? 0,
        deposit: a ? (heldDeposits.get(a.id) ?? 0) : 0,
        balance: a ? (balance.get(a.id) ?? 0) : 0,
      };
    })
    .sort((x, y) => x.unit.localeCompare(y.unit));
  const occupied = rows.filter((r) => r.status === 'occupied');
  const rentable = inp.units.filter((u) => u.active).length;
  return {
    key: 'rent_roll', title: 'Rent roll', window: { from: inp.from, to: inp.to },
    subtitle: 'Rate is per the agreement term (nightly stays show the nightly rate).',
    columns: [
      { key: 'unit', label: 'Unit', kind: 'text' }, { key: 'property', label: 'Property', kind: 'text' },
      { key: 'floorplan', label: 'Floorplan', kind: 'text' },
      { key: 'status', label: 'Status', kind: 'text' },
      { key: 'resident', label: 'Resident', kind: 'text' }, { key: 'kind', label: 'Type', kind: 'text' },
      { key: 'leaseStart', label: 'Start', kind: 'date' }, { key: 'leaseEnd', label: 'End', kind: 'date' },
      { key: 'rent', label: 'Rate', kind: 'money' }, { key: 'deposit', label: 'Deposit held', kind: 'money' },
      { key: 'balance', label: 'Balance', kind: 'money' },
    ],
    rows,
    kpis: [
      { label: 'Occupancy', value: pct(occupied.length, rentable), kind: 'percent' },
      { label: 'Occupied / rentable', value: occupied.length, kind: 'number' },
      { label: 'Scheduled rent', value: sum(occupied.map((r) => r.rent)), kind: 'money' },
      { label: 'Outstanding balances', value: sum(rows.map((r) => r.balance)), kind: 'money' },
      { label: 'Deposits held', value: sum(rows.map((r) => r.deposit)), kind: 'money' },
    ],
  };
}

function delinquency(inp: ReportingInput): Report {
  const ag = new Map(inp.agreements.map((a) => [a.id, a]));
  const unitLabel = new Map(inp.units.map((u) => [u.id, u.label]));
  const acc = new Map<string, { current: number; d1_30: number; d31_60: number; d61_90: number; d90: number; total: number }>();
  for (const i of inp.invoices) {
    if (!OPEN_INV.has(i.status)) continue;
    const due = outstanding(i);
    if (due <= 0) continue;
    const past = ms(i.dueAt) < ms(inp.now) ? daysBetween(i.dueAt, inp.now) : -1;
    const b = acc.get(i.agreementId) ?? { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90: 0, total: 0 };
    if (past < 0) b.current += due;
    else if (past <= 30) b.d1_30 += due;
    else if (past <= 60) b.d31_60 += due;
    else if (past <= 90) b.d61_90 += due;
    else b.d90 += due;
    b.total += due;
    acc.set(i.agreementId, b);
  }
  const rows = [...acc.entries()]
    .map(([agId, b]) => {
      const a = ag.get(agId);
      return { resident: a?.residentName ?? agId, unit: a ? (unitLabel.get(a.unitId) ?? a.unitId) : '—', ...b };
    })
    .sort((x, y) => y.total - x.total);
  const pastDue = sum(rows.map((r) => r.total - r.current));
  return {
    key: 'delinquency', title: 'Delinquency (aged receivables)', window: { from: inp.from, to: inp.to },
    subtitle: '“Current” is billed but not yet due; everything else is past due by bucket.',
    columns: [
      { key: 'resident', label: 'Resident', kind: 'text' }, { key: 'unit', label: 'Unit', kind: 'text' },
      { key: 'current', label: 'Current', kind: 'money' }, { key: 'd1_30', label: '1–30', kind: 'money' },
      { key: 'd31_60', label: '31–60', kind: 'money' }, { key: 'd61_90', label: '61–90', kind: 'money' },
      { key: 'd90', label: '90+', kind: 'money' }, { key: 'total', label: 'Total', kind: 'money' },
    ],
    rows,
    kpis: [
      { label: 'Past due', value: pastDue, kind: 'money' },
      { label: 'Accounts with balance', value: rows.length, kind: 'number' },
      { label: '90+ days', value: sum(rows.map((r) => r.d90)), kind: 'money' },
      { label: 'Total receivable', value: sum(rows.map((r) => r.total)), kind: 'money' },
    ],
  };
}

function leaseExpirations(inp: ReportingInput): Report {
  const today = inp.now.slice(0, 10);
  const active = inp.agreements.filter((a) => a.status === 'active');
  const buckets = new Map<string, { count: number; rent: number }>();
  for (const a of active) {
    const end = a.end.slice(0, 10);
    const key = end <= today ? 'holdover (past end)' : monthKey(end);
    const b = buckets.get(key) ?? { count: 0, rent: 0 };
    b.count += 1; b.rent += a.rateCents;
    buckets.set(key, b);
  }
  const rows = [...buckets.entries()]
    .map(([month, b]) => ({ month, count: b.count, rentAtRisk: b.rent }))
    .sort((x, y) => x.month.localeCompare(y.month));
  const withinDays = (d: number) => active.filter((a) => { const end = a.end.slice(0, 10); return end > today && daysBetween(today, end) <= d; });
  return {
    key: 'lease_expirations', title: 'Lease expirations', window: { from: inp.from, to: inp.to },
    columns: [
      { key: 'month', label: 'Expiration month', kind: 'text' },
      { key: 'count', label: 'Agreements', kind: 'number' },
      { key: 'rentAtRisk', label: 'Rent at risk', kind: 'money' },
    ],
    rows,
    kpis: [
      { label: 'Expiring ≤30d', value: withinDays(30).length, kind: 'number' },
      { label: 'Expiring ≤60d', value: withinDays(60).length, kind: 'number' },
      { label: 'Expiring ≤90d', value: withinDays(90).length, kind: 'number' },
      { label: 'Rent at risk ≤90d', value: sum(withinDays(90).map((a) => a.rateCents)), kind: 'money' },
    ],
  };
}

function boxScore(inp: ReportingInput): Report {
  const win = (d: string) => inWindow(d, inp.from, inp.to);
  const moveIns = inp.agreements.filter((a) => win(a.start));
  const moveOuts = inp.agreements.filter((a) => win(a.end));
  const newLeads = inp.leads.filter((l) => win(l.createdAt));
  const signed = inp.leads.filter((l) => l.stage === 'signed' && win(l.updatedAt));
  const lost = inp.leads.filter((l) => l.stage === 'lost' && win(l.updatedAt));
  const occ = currentAgreementByUnit(inp);
  const rentable = inp.units.filter((u) => u.active).length;
  const rows = [
    { metric: 'Move-ins (agreement starts)', value: moveIns.length },
    { metric: 'Move-outs (agreement ends)', value: moveOuts.length },
    { metric: 'Net change', value: moveIns.length - moveOuts.length },
    { metric: 'New leads', value: newLeads.length },
    { metric: 'Leases signed', value: signed.length },
    { metric: 'Leads lost', value: lost.length },
    { metric: 'Units occupied today', value: occ.size },
    { metric: 'Rentable units', value: rentable },
  ];
  return {
    key: 'box_score', title: 'Box score (leasing activity)', window: { from: inp.from, to: inp.to },
    columns: [{ key: 'metric', label: 'Metric', kind: 'text' }, { key: 'value', label: 'Value', kind: 'number' }],
    rows,
    kpis: [
      { label: 'Occupancy', value: pct(occ.size, rentable), kind: 'percent' },
      { label: 'Move-ins', value: moveIns.length, kind: 'number' },
      { label: 'Move-outs', value: moveOuts.length, kind: 'number' },
      { label: 'Signed', value: signed.length, kind: 'number' },
    ],
  };
}

function vacancy(inp: ReportingInput): Report {
  const occ = currentAgreementByUnit(inp);
  const today = inp.now.slice(0, 10);
  const rows = inp.units
    .filter((u) => u.active && !occ.has(u.id))
    .map((u) => {
      const past = inp.agreements.filter((a) => a.unitId === u.id && a.end.slice(0, 10) <= today);
      const lastEnd = past.length ? past.map((a) => a.end.slice(0, 10)).sort().pop()! : null;
      const anyAg = inp.agreements.filter((a) => a.unitId === u.id).sort((x, y) => y.start.localeCompare(x.start))[0];
      return {
        unit: u.label,
        lastOccupied: lastEnd ?? 'never occupied',
        daysVacant: lastEnd ? daysBetween(lastEnd, today) : ('—' as unknown as number),
        rentAtRisk: anyAg?.rateCents ?? 0,
      };
    })
    .sort((x, y) => (Number(y.daysVacant) || 1e9) - (Number(x.daysVacant) || 1e9));
  const rentable = inp.units.filter((u) => u.active).length;
  return {
    key: 'vacancy', title: 'Vacancy & availability', window: { from: inp.from, to: inp.to },
    subtitle: 'Rent at risk uses the unit’s most recent agreement rate.',
    columns: [
      { key: 'unit', label: 'Unit', kind: 'text' }, { key: 'lastOccupied', label: 'Last occupied until', kind: 'date' },
      { key: 'daysVacant', label: 'Days vacant', kind: 'number' }, { key: 'rentAtRisk', label: 'Rent at risk', kind: 'money' },
    ],
    rows,
    kpis: [
      { label: 'Vacant units', value: rows.length, kind: 'number' },
      { label: 'Vacancy', value: pct(rows.length, rentable), kind: 'percent' },
      { label: 'Rent at risk', value: sum(rows.map((r) => r.rentAtRisk)), kind: 'money' },
    ],
  };
}

function woAging(inp: ReportingInput): Report {
  const open = inp.workOrders.filter((w) => !['completed', 'cancelled'].includes(w.status));
  const rows = open
    .map((w) => ({ workOrder: w.title ?? w.id, priority: w.priority, status: w.status, daysOpen: daysBetween(w.openedAt, inp.now) }))
    .sort((x, y) => y.daysOpen - x.daysOpen);
  return {
    key: 'wo_aging', title: 'Work-order aging', window: { from: inp.from, to: inp.to },
    columns: [
      { key: 'workOrder', label: 'Work order', kind: 'text' }, { key: 'priority', label: 'Priority', kind: 'text' },
      { key: 'status', label: 'Status', kind: 'text' }, { key: 'daysOpen', label: 'Days open', kind: 'number' },
    ],
    rows,
    kpis: [
      { label: 'Open', value: rows.length, kind: 'number' },
      { label: 'High/urgent', value: open.filter((w) => w.priority === 'high' || w.priority === 'urgent').length, kind: 'number' },
      { label: 'Oldest (days)', value: rows.length ? rows[0]!.daysOpen : 0, kind: 'number' },
    ],
  };
}

/** Make-ready aging: every unit turn with its days-in-turn + open-task count, and
 *  the portfolio turn-time KPIs (units in turn, average days-to-ready of the
 *  turns that finished, longest open turn). The ops director's turn scorecard. */
function makeReady(inp: ReportingInput): Report {
  const turns = inp.turns ?? [];
  const rows = turns
    .map((t) => ({ unit: t.unitLabel, status: t.status.replace('_', ' '), days: t.days, openTasks: t.openTasks }))
    .sort((x, y) => y.days - x.days);
  const inTurn = turns.filter((t) => t.status === 'open' || t.status === 'in_progress');
  const ready = turns.filter((t) => t.status === 'ready');
  const avgReady = ready.length ? Math.round(ready.reduce((n, t) => n + t.days, 0) / ready.length) : 0;
  const longestOpen = inTurn.reduce((m, t) => Math.max(m, t.days), 0);
  return {
    key: 'make_ready', title: 'Make-ready (turn time)', window: { from: inp.from, to: inp.to },
    subtitle: 'Every unit turn with days-in-turn; turn time (vacate → rent-ready) is the operations KPI.',
    columns: [
      { key: 'unit', label: 'Unit', kind: 'text' }, { key: 'status', label: 'Status', kind: 'text' },
      { key: 'days', label: 'Days in turn', kind: 'number' }, { key: 'openTasks', label: 'Open tasks', kind: 'number' },
    ],
    rows,
    kpis: [
      { label: 'In turn', value: inTurn.length, kind: 'number' },
      { label: 'Avg days to ready', value: avgReady, kind: 'number' },
      { label: 'Longest open (days)', value: longestOpen, kind: 'number' },
      { label: 'Made ready', value: ready.length, kind: 'number' },
    ],
  };
}

// Coverage classification over the report's minimal policy shape (mirrors
// insurance.ts policyInForce/coverageStatus without the full record type).
type PolicyLite = { effectiveAt: string; expiresAt: string; status: string };
function insurancePolicyInForce(p: PolicyLite, asOf: string): boolean {
  if (p.status !== 'active') return false;
  const at = ms(asOf.slice(0, 10)), from = ms(p.effectiveAt.slice(0, 10)), to = ms(p.expiresAt.slice(0, 10));
  if (Number.isNaN(at) || Number.isNaN(from) || Number.isNaN(to)) return false;
  return from <= at && at < to;
}
function insuranceCoverage(policies: readonly PolicyLite[], asOf: string, withinDays = 30): 'compliant' | 'expiring' | 'lapsed' | 'none' {
  if (policies.length === 0) return 'none';
  const inForce = policies.filter((p) => insurancePolicyInForce(p, asOf));
  if (inForce.length === 0) return 'lapsed';
  const at = ms(asOf.slice(0, 10));
  const coverThrough = Math.max(...inForce.map((p) => ms(p.expiresAt.slice(0, 10))));
  return coverThrough - at <= withinDays * DAY ? 'expiring' : 'compliant';
}

/** Renters-insurance compliance: one row per active lease with its coverage
 *  status as of now (compliant / expiring / lapsed / none). Coverage is the
 *  pure classification of the lease's policies. */
function insuranceCompliance(inp: ReportingInput): Report {
  const policies = inp.insurancePolicies ?? [];
  const byAgreement = new Map<string, typeof policies[number][]>();
  for (const p of policies) {
    const list = byAgreement.get(p.agreementId) ?? [];
    list.push(p);
    byAgreement.set(p.agreementId, list);
  }
  const unitLabel = new Map(inp.units.map((u) => [u.id, u.label] as const));
  // Active residential leases are the population that must carry coverage.
  const leases = inp.agreements.filter((a) => a.status === 'active' && (a.kind === 'lease' || a.kind === 'monthly'));
  const rank: Record<string, number> = { none: 0, lapsed: 1, expiring: 2, compliant: 3 };
  const rows = leases
    .map((a) => {
      const ps = byAgreement.get(a.id) ?? [];
      const status = insuranceCoverage(ps, inp.now);
      const inForce = ps.filter((p) => insurancePolicyInForce(p, inp.now));
      const cover = inForce.sort((x, y) => ms(y.expiresAt) - ms(x.expiresAt))[0];
      return {
        resident: a.residentName ?? '—',
        unit: unitLabel.get(a.unitId) ?? a.unitId,
        carrier: cover?.carrier ?? (ps[0]?.carrier ?? '—'),
        liabilityCents: cover?.liabilityCents ?? 0,
        expires: cover?.expiresAt ?? (ps[0]?.expiresAt ?? '—'),
        status,
      };
    })
    .sort((x, y) => (rank[x.status]! - rank[y.status]!));
  const covered = rows.filter((r) => r.status === 'compliant' || r.status === 'expiring').length;
  const expiring = rows.filter((r) => r.status === 'expiring').length;
  const uncovered = rows.filter((r) => r.status === 'lapsed' || r.status === 'none').length;
  return {
    key: 'insurance_compliance', title: 'Insurance compliance', window: { from: inp.from, to: inp.to },
    subtitle: 'Renters-insurance coverage per active lease — every lapsed policy is uninsured liability.',
    columns: [
      { key: 'resident', label: 'Resident', kind: 'text' }, { key: 'unit', label: 'Unit', kind: 'text' },
      { key: 'carrier', label: 'Carrier', kind: 'text' }, { key: 'liabilityCents', label: 'Liability', kind: 'money' },
      { key: 'expires', label: 'Expires', kind: 'date' }, { key: 'status', label: 'Coverage', kind: 'text' },
    ],
    rows,
    kpis: [
      { label: 'Active leases', value: rows.length, kind: 'number' },
      { label: 'Insured', value: covered, kind: 'number' },
      { label: 'Compliance rate', value: pct(covered, rows.length), kind: 'percent' },
      { label: 'Uninsured / lapsed', value: uncovered, kind: 'number' },
      { label: 'Expiring soon', value: expiring, kind: 'number' },
    ],
  };
}

/** Package room: parcels still at the desk, longest-waiting first. */
function packageRoom(inp: ReportingInput): Report {
  const parcels = (inp.parcels ?? []);
  const awaiting = parcels.filter((p) => p.status !== 'picked_up');
  const rows = awaiting
    .map((p) => ({ recipient: p.recipientName, unit: p.unitLabel ?? '—', carrier: p.carrier, status: p.status.replace('_', ' '), days: p.daysWaiting }))
    .sort((a, b) => b.days - a.days);
  const stale = awaiting.filter((p) => p.daysWaiting >= 7).length;
  const longest = awaiting.reduce((m, p) => Math.max(m, p.daysWaiting), 0);
  return {
    key: 'package_room', title: 'Package room', window: { from: inp.from, to: inp.to },
    subtitle: 'Parcels awaiting pickup at the front desk — every unclaimed box takes shelf space.',
    columns: [
      { key: 'recipient', label: 'Recipient', kind: 'text' }, { key: 'unit', label: 'Unit', kind: 'text' },
      { key: 'carrier', label: 'Carrier', kind: 'text' }, { key: 'status', label: 'Status', kind: 'text' },
      { key: 'days', label: 'Days waiting', kind: 'number' },
    ],
    rows,
    kpis: [
      { label: 'Awaiting pickup', value: awaiting.length, kind: 'number' },
      { label: 'Waiting 7+ days', value: stale, kind: 'number' },
      { label: 'Longest wait (days)', value: longest, kind: 'number' },
      { label: 'Picked up', value: parcels.length - awaiting.length, kind: 'number' },
    ],
  };
}

/** Waitlist demand: prospects still waiting/offered, grouped by floorplan. */
function waitlistDemand(inp: ReportingInput): Report {
  const active = (inp.waitlist ?? []).filter((e) => e.status === 'waiting' || e.status === 'offered');
  const byPlan = new Map<string, number>();
  for (const e of active) { const k = e.floorplanName ?? 'Any / unspecified'; byPlan.set(k, (byPlan.get(k) ?? 0) + 1); }
  const rows = [...byPlan.entries()].map(([floorplan, waiting]) => ({ floorplan, waiting })).sort((a, b) => b.waiting - a.waiting);
  return {
    key: 'waitlist_demand', title: 'Waitlist demand', window: { from: inp.from, to: inp.to },
    subtitle: 'Prospects waiting per floorplan — a demand signal for pricing and unit releases.',
    columns: [
      { key: 'floorplan', label: 'Floorplan', kind: 'text' }, { key: 'waiting', label: 'Prospects waiting', kind: 'number' },
    ],
    rows,
    kpis: [
      { label: 'Waiting', value: active.length, kind: 'number' },
      { label: 'Floorplans with demand', value: byPlan.size, kind: 'number' },
      { label: 'Converted', value: (inp.waitlist ?? []).filter((e) => e.status === 'converted').length, kind: 'number' },
    ],
  };
}

/** Owner distributions: cash returned to each owning entity/community in the
 *  window (the capital-return side of the owner statement). */
function ownerDistributions(inp: ReportingInput): Report {
  const inWin = (inp.distributions ?? []).filter((d) => inWindow(d.recordedAt, inp.from, inp.to));
  const byOwner = new Map<string, { entity: string; property: string; cents: number }>();
  for (const d of inWin) {
    const property = d.propertyName ?? 'Portfolio / unattributed';
    const key = `${d.entityName} ${property}`;
    const row = byOwner.get(key) ?? { entity: d.entityName, property, cents: 0 };
    row.cents += d.amountCents;
    byOwner.set(key, row);
  }
  const rows = [...byOwner.values()].map((r) => ({ entity: r.entity, property: r.property, distributed: r.cents })).sort((a, b) => b.distributed - a.distributed);
  const total = sum(inWin.map((d) => d.amountCents));
  return {
    key: 'owner_distributions', title: 'Owner distributions', window: { from: inp.from, to: inp.to },
    subtitle: 'Cash distributed to owning entities in the window — the capital-return side of the owner statement.',
    columns: [
      { key: 'entity', label: 'Owning entity', kind: 'text' }, { key: 'property', label: 'Community', kind: 'text' },
      { key: 'distributed', label: 'Distributed', kind: 'money' },
    ],
    rows,
    kpis: [
      { label: 'Total distributed', value: total, kind: 'money' },
      { label: 'Distributions', value: inWin.length, kind: 'number' },
      { label: 'Owning entities', value: new Set(inWin.map((d) => d.entityName)).size, kind: 'number' },
    ],
  };
}

/** Owner capital accounts: per owning entity, contributions in − distributions
 *  out = net invested. The classic investor capital account. */
function capitalAccounts(inp: ReportingInput): Report {
  const byEntity = new Map<string, { contributed: number; distributed: number }>();
  for (const c of inp.contributions ?? []) { const r = byEntity.get(c.entityName) ?? { contributed: 0, distributed: 0 }; r.contributed += c.amountCents; byEntity.set(c.entityName, r); }
  for (const d of inp.distributions ?? []) { const r = byEntity.get(d.entityName) ?? { contributed: 0, distributed: 0 }; r.distributed += d.amountCents; byEntity.set(d.entityName, r); }
  const rows = [...byEntity.entries()].map(([entity, r]) => ({ entity, contributed: r.contributed, distributed: r.distributed, net: r.contributed - r.distributed })).sort((a, b) => b.net - a.net);
  return {
    key: 'capital_account', title: 'Capital accounts', window: { from: inp.from, to: inp.to },
    subtitle: 'Per owning entity: capital contributed in, distributions paid out, net invested.',
    columns: [
      { key: 'entity', label: 'Owning entity', kind: 'text' }, { key: 'contributed', label: 'Contributed', kind: 'money' },
      { key: 'distributed', label: 'Distributed', kind: 'money' }, { key: 'net', label: 'Net invested', kind: 'money' },
    ],
    rows,
    kpis: [
      { label: 'Total contributed', value: sum(rows.map((r) => r.contributed)), kind: 'money' },
      { label: 'Total distributed', value: sum(rows.map((r) => r.distributed)), kind: 'money' },
      { label: 'Net invested', value: sum(rows.map((r) => r.net)), kind: 'money' },
      { label: 'Owning entities', value: rows.length, kind: 'number' },
    ],
  };
}

// --- financial statements (GL-based) -----------------------------------------

/** P&L for the window: revenue accounts are credit-normal, expenses debit-normal.
 *  Net operating income = revenue − expenses. */
function incomeStatement(inp: ReportingInput): Report {
  const lines = (inp.ledgerLines ?? []).filter((l) => inWindow(l.postedAt, inp.from, inp.to));
  const byAccount = new Map<string, number>();
  for (const l of lines) {
    if (l.account.startsWith('revenue')) byAccount.set(l.account, (byAccount.get(l.account) ?? 0) + (l.creditCents - l.debitCents));
    else if (l.account.startsWith('expense')) byAccount.set(l.account, (byAccount.get(l.account) ?? 0) + (l.debitCents - l.creditCents));
  }
  const income = [...byAccount.entries()].filter(([a]) => a.startsWith('revenue')).map(([account, amount]) => ({ group: 'Income', account, amount })).sort((x, y) => y.amount - x.amount);
  const expenses = [...byAccount.entries()].filter(([a]) => a.startsWith('expense')).map(([account, amount]) => ({ group: 'Expense', account, amount })).sort((x, y) => y.amount - x.amount);
  const revenueTotal = sum(income.map((r) => r.amount));
  const expenseTotal = sum(expenses.map((r) => r.amount));
  const noi = revenueTotal - expenseTotal;
  return {
    key: 'income_statement', title: 'Income statement', window: { from: inp.from, to: inp.to },
    subtitle: 'Accrual basis, straight from the ledger: revenue when billed, expenses when the bill posts.',
    columns: [
      { key: 'group', label: 'Section', kind: 'text' }, { key: 'account', label: 'Account', kind: 'text' },
      { key: 'amount', label: 'Amount', kind: 'money' },
    ],
    rows: [...income, ...expenses],
    kpis: [
      { label: 'Revenue', value: revenueTotal, kind: 'money' },
      { label: 'Expenses', value: expenseTotal, kind: 'money' },
      { label: 'Net operating income', value: noi, kind: 'money' },
      { label: 'Margin', value: revenueTotal > 0 ? pct(noi, revenueTotal) : 0, kind: 'percent' },
    ],
  };
}

/** Owner statement — a P&L per property/community for the window: revenue,
 *  expenses and net operating income by community, each labelled with its
 *  owning legal entity. The core artifact an institutional owner or fund
 *  receives. Lines with no property stamp fold into "Unassigned". */
function ownerStatement(inp: ReportingInput): Report {
  const lines = (inp.ledgerLines ?? []).filter((l) => inWindow(l.postedAt, inp.from, inp.to));
  const meta = new Map((inp.properties ?? []).map((p) => [p.id, p]));
  const byProp = new Map<string, { revenue: number; expense: number }>();
  for (const l of lines) {
    const key = l.propertyId ?? '—';
    const g = byProp.get(key) ?? { revenue: 0, expense: 0 };
    if (l.account.startsWith('revenue')) g.revenue += l.creditCents - l.debitCents;
    else if (l.account.startsWith('expense')) g.expense += l.debitCents - l.creditCents;
    byProp.set(key, g);
  }
  const rows = [...byProp.entries()].map(([id, g]) => {
    const m = meta.get(id);
    return {
      property: m?.name ?? (id === '—' ? 'Unassigned' : id),
      owner: m?.entityName ?? '—',
      revenue: g.revenue,
      expenses: g.expense,
      noi: g.revenue - g.expense,
    };
  }).sort((x, y) => y.noi - x.noi);
  const revenueTotal = sum(rows.map((r) => r.revenue));
  const expenseTotal = sum(rows.map((r) => r.expenses));
  return {
    key: 'owner_statement', title: 'Owner statement', window: { from: inp.from, to: inp.to },
    subtitle: 'Net operating income by property for the window, with the owning legal entity — the fund/owner report.',
    columns: [
      { key: 'property', label: 'Property', kind: 'text' }, { key: 'owner', label: 'Owning entity', kind: 'text' },
      { key: 'revenue', label: 'Revenue', kind: 'money' }, { key: 'expenses', label: 'Expenses', kind: 'money' },
      { key: 'noi', label: 'NOI', kind: 'money' },
    ],
    rows,
    kpis: [
      { label: 'Communities', value: rows.length, kind: 'number' },
      { label: 'Revenue', value: revenueTotal, kind: 'money' },
      { label: 'Expenses', value: expenseTotal, kind: 'money' },
      { label: 'Net operating income', value: revenueTotal - expenseTotal, kind: 'money' },
    ],
  };
}

/** Budget vs actual NOI per community: the plan against ledger actuals. */
function propertyBudgetReport(inp: ReportingInput): Report {
  const meta = new Map((inp.properties ?? []).map((p) => [p.id, p.name]));
  // Actuals per property over each budget's own period.
  const rows = (inp.propertyBudgets ?? []).map((b) => {
    let actRev = 0, actExp = 0;
    for (const l of inp.ledgerLines ?? []) {
      if (l.propertyId !== b.propertyId) continue;
      if (l.postedAt < b.periodStart || l.postedAt >= b.periodEnd) continue;
      if (l.account.startsWith('revenue')) actRev += l.creditCents - l.debitCents;
      else if (l.account.startsWith('expense')) actExp += l.debitCents - l.creditCents;
    }
    const budgetNoi = b.budgetRevenueCents - b.budgetExpenseCents;
    const actualNoi = actRev - actExp;
    return {
      property: b.propertyName ?? meta.get(b.propertyId) ?? b.propertyId,
      budget_noi: budgetNoi,
      actual_noi: actualNoi,
      variance: actualNoi - budgetNoi,
      margin: actRev > 0 ? Math.round((actualNoi / actRev) * 1000) / 10 : 0,
    };
  }).sort((a, b) => a.variance - b.variance);
  const budgetTotal = sum(rows.map((r) => r.budget_noi));
  const actualTotal = sum(rows.map((r) => r.actual_noi));
  return {
    key: 'property_budget', title: 'Budget vs actual (NOI)', window: { from: inp.from, to: inp.to },
    subtitle: 'Planned vs actual net operating income per community, from the operating budgets and the ledger.',
    columns: [
      { key: 'property', label: 'Community', kind: 'text' },
      { key: 'budget_noi', label: 'Budget NOI', kind: 'money' },
      { key: 'actual_noi', label: 'Actual NOI', kind: 'money' },
      { key: 'variance', label: 'Variance', kind: 'money' },
      { key: 'margin', label: 'Actual margin', kind: 'percent' },
    ],
    rows,
    kpis: [
      { label: 'Communities budgeted', value: rows.length, kind: 'number' },
      { label: 'Budget NOI', value: budgetTotal, kind: 'money' },
      { label: 'Actual NOI', value: actualTotal, kind: 'money' },
      { label: 'NOI variance', value: actualTotal - budgetTotal, kind: 'money' },
    ],
  };
}

/** Balance sheet as of the window end: Assets = Liabilities + Equity, where
 *  current-period earnings (revenue − expenses, all-time) roll into equity. From
 *  the ledger; a healthy book balances to zero. */
function balanceSheet(inp: ReportingInput): Report {
  const asOf = inp.to;
  const lines = (inp.ledgerLines ?? []).filter((l) => ms(l.postedAt) < ms(asOf));
  const bal = new Map<string, number>(); // debit-positive natural balance per account
  let netIncome = 0;
  for (const l of lines) {
    if (l.account.startsWith('revenue')) netIncome += l.creditCents - l.debitCents;
    else if (l.account.startsWith('expense')) netIncome -= l.debitCents - l.creditCents;
    else bal.set(l.account, (bal.get(l.account) ?? 0) + (l.debitCents - l.creditCents));
  }
  const section = (prefix: string, sign: 1 | -1) =>
    [...bal.entries()].filter(([a]) => a.startsWith(prefix)).map(([account, v]) => ({ account, amount: v * sign })).filter((r) => r.amount !== 0).sort((x, y) => y.amount - x.amount);
  const assets = section('assets', 1);
  const liabilities = section('liabilities', -1); // credit-normal
  const equity = section('equity', -1);
  const assetsTotal = sum(assets.map((r) => r.amount));
  const liabilitiesTotal = sum(liabilities.map((r) => r.amount));
  const equityPosted = sum(equity.map((r) => r.amount));
  const equityTotal = equityPosted + netIncome;
  const rows = [
    { group: 'Assets', account: '', amount: null as number | null },
    ...assets.map((r) => ({ group: '', account: r.account, amount: r.amount })),
    { group: 'Total assets', account: '', amount: assetsTotal },
    { group: 'Liabilities', account: '', amount: null },
    ...liabilities.map((r) => ({ group: '', account: r.account, amount: r.amount })),
    { group: 'Total liabilities', account: '', amount: liabilitiesTotal },
    { group: 'Equity', account: '', amount: null },
    ...equity.map((r) => ({ group: '', account: r.account, amount: r.amount })),
    { group: '', account: 'equity:current_earnings', amount: netIncome },
    { group: 'Total equity', account: '', amount: equityTotal },
    { group: 'Liabilities + equity', account: '', amount: liabilitiesTotal + equityTotal },
  ];
  return {
    key: 'balance_sheet', title: 'Balance sheet', window: { from: inp.from, to: inp.to },
    subtitle: `Financial position as of ${asOf.slice(0, 10)}. Assets = Liabilities + Equity (current earnings roll into equity).`,
    columns: [
      { key: 'group', label: 'Section', kind: 'text' }, { key: 'account', label: 'Account', kind: 'text' }, { key: 'amount', label: 'Balance', kind: 'money' },
    ],
    rows,
    kpis: [
      { label: 'Total assets', value: assetsTotal, kind: 'money' },
      { label: 'Total liabilities', value: liabilitiesTotal, kind: 'money' },
      { label: 'Total equity', value: equityTotal, kind: 'money' },
      { label: 'Balances (A − L − E)', value: assetsTotal - liabilitiesTotal - equityTotal, kind: 'money' },
    ],
  };
}

/** Trailing-twelve-months P&L: revenue, expense and NOI for each of the 12
 *  months ending at the window end — the flagship multifamily operating trend. */
function trailingTwelve(inp: ReportingInput): Report {
  const end = new Date(inp.to);
  const endY = end.getUTCFullYear(); const endM = end.getUTCMonth(); // 0-based; window-end month is exclusive-ish
  const months: string[] = [];
  for (let i = 12; i >= 1; i--) {
    const d = new Date(Date.UTC(endY, endM - i, 1));
    months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  const idx = new Map(months.map((m, i) => [m, i]));
  const rev = new Array(12).fill(0); const exp = new Array(12).fill(0);
  for (const l of inp.ledgerLines ?? []) {
    const m = l.postedAt.slice(0, 7);
    const i = idx.get(m); if (i === undefined) continue;
    if (l.account.startsWith('revenue')) rev[i] += l.creditCents - l.debitCents;
    else if (l.account.startsWith('expense')) exp[i] += l.debitCents - l.creditCents;
  }
  const rows = months.map((m, i) => ({ month: m, revenue: rev[i], expenses: exp[i], noi: rev[i] - exp[i], margin: rev[i] > 0 ? pct(rev[i] - exp[i], rev[i]) : 0 }));
  const revT = sum(rev); const expT = sum(exp);
  rows.push({ month: 'T-12 total', revenue: revT, expenses: expT, noi: revT - expT, margin: revT > 0 ? pct(revT - expT, revT) : 0 });
  return {
    key: 'trailing_twelve', title: 'Trailing 12 months (T-12)', window: { from: months[0] + '-01', to: inp.to },
    subtitle: 'Month-by-month revenue, expenses and NOI over the trailing twelve months — the standard operating statement for underwriting.',
    columns: [
      { key: 'month', label: 'Month', kind: 'text' }, { key: 'revenue', label: 'Revenue', kind: 'money' },
      { key: 'expenses', label: 'Expenses', kind: 'money' }, { key: 'noi', label: 'NOI', kind: 'money' }, { key: 'margin', label: 'Margin', kind: 'percent' },
    ],
    rows,
    kpis: [
      { label: 'T-12 revenue', value: revT, kind: 'money' },
      { label: 'T-12 expenses', value: expT, kind: 'money' },
      { label: 'T-12 NOI', value: revT - expT, kind: 'money' },
      { label: 'T-12 margin', value: revT > 0 ? pct(revT - expT, revT) : 0, kind: 'percent' },
    ],
  };
}

/** Comparative P&L: revenue/expense/NOI this window vs the prior window of equal
 *  length, with variance $ and %. The "how are we trending" finance view. */
function pnlComparison(inp: ReportingInput): Report {
  const prev = priorWindow(inp.from, inp.to);
  const fold = (from: string, to: string) => {
    let rev = 0, exp = 0;
    for (const l of inp.ledgerLines ?? []) {
      if (!inWindow(l.postedAt, from, to)) continue;
      if (l.account.startsWith('revenue')) rev += l.creditCents - l.debitCents;
      else if (l.account.startsWith('expense')) exp += l.debitCents - l.creditCents;
    }
    return { rev, exp, noi: rev - exp };
  };
  const cur = fold(inp.from, inp.to);
  const pri = fold(prev.from, prev.to);
  const line = (label: string, c: number, p: number) => ({ line: label, current: c, prior: p, variance: c - p, variance_pct: p !== 0 ? pct(c - p, Math.abs(p)) : 0 });
  const rows = [line('Revenue', cur.rev, pri.rev), line('Expenses', cur.exp, pri.exp), line('Net operating income', cur.noi, pri.noi)];
  return {
    key: 'pnl_comparison', title: 'P&L — period comparison', window: { from: inp.from, to: inp.to },
    subtitle: 'This period vs the prior period of equal length, with variance — the trend view finance leads on.',
    columns: [
      { key: 'line', label: '', kind: 'text' }, { key: 'current', label: 'This period', kind: 'money' },
      { key: 'prior', label: 'Prior period', kind: 'money' }, { key: 'variance', label: 'Variance', kind: 'money' }, { key: 'variance_pct', label: 'Variance %', kind: 'percent' },
    ],
    rows,
    kpis: [
      { label: 'NOI this period', value: cur.noi, kind: 'money' },
      { label: 'NOI prior period', value: pri.noi, kind: 'money' },
      { label: 'NOI variance', value: cur.noi - pri.noi, kind: 'money' },
      { label: 'NOI variance %', value: pri.noi !== 0 ? pct(cur.noi - pri.noi, Math.abs(pri.noi)) : 0, kind: 'percent' },
    ],
  };
}

/** All-time balances per account: the books, netting to zero when balanced. */
function generalLedger(inp: ReportingInput): Report {
  const acc = new Map<string, { debits: number; credits: number }>();
  for (const l of inp.ledgerLines ?? []) {
    const a = acc.get(l.account) ?? { debits: 0, credits: 0 };
    a.debits += l.debitCents; a.credits += l.creditCents;
    acc.set(l.account, a);
  }
  const rows = [...acc.entries()]
    .map(([account, a]) => ({ account, debits: a.debits, credits: a.credits, balance: a.debits - a.credits }))
    .sort((x, y) => x.account.localeCompare(y.account));
  return {
    key: 'general_ledger', title: 'General ledger (trial balance)', window: { from: inp.from, to: inp.to },
    subtitle: 'All-time account balances. A healthy ledger nets to zero.',
    columns: [
      { key: 'account', label: 'Account', kind: 'text' }, { key: 'debits', label: 'Debits', kind: 'money' },
      { key: 'credits', label: 'Credits', kind: 'money' }, { key: 'balance', label: 'Balance (DR−CR)', kind: 'money' },
    ],
    rows,
    kpis: [
      { label: 'Accounts', value: rows.length, kind: 'number' },
      { label: 'Total debits', value: sum(rows.map((r) => r.debits)), kind: 'money' },
      { label: 'Total credits', value: sum(rows.map((r) => r.credits)), kind: 'money' },
      { label: 'Net (should be 0)', value: sum(rows.map((r) => r.balance)), kind: 'money' },
    ],
  };
}

/** Statement of cash flows: opening cash → operating / investing / financing
 *  movements in the window → closing cash. Each cash movement is classified by
 *  the counterpart account(s) of its journal entry (double-entry: every cash
 *  line has an offsetting non-cash line). Requires ledgerLines to carry entryId. */
function isCash(account: string): boolean { return account.startsWith('assets:cash'); }
function classifyCounterpart(account: string): 'operating' | 'investing' | 'financing' {
  if (account.startsWith('revenue') || account.startsWith('expense')) return 'operating';
  if (account.startsWith('assets:accounts_receivable') || account.startsWith('liabilities:accounts_payable')) return 'operating';
  if (account.startsWith('liabilities:deposits_held') || account.startsWith('liabilities:due_to')) return 'financing';
  if (account.startsWith('assets')) return 'investing'; // a non-cash asset (equipment, prepaid)
  if (account.startsWith('liabilities') || account.startsWith('equity')) return 'financing';
  return 'operating';
}
function cashFlowStatement(inp: ReportingInput): Report {
  const all = inp.ledgerLines ?? [];
  // Opening cash: net cash movement strictly before the window.
  let opening = 0;
  for (const l of all) if (isCash(l.account) && ms(l.postedAt) < ms(inp.from)) opening += l.debitCents - l.creditCents;
  // Group the in-window lines by entry so each cash movement finds its counterpart.
  const entries = new Map<string, typeof all[number][]>();
  for (const l of all) {
    if (!inWindow(l.postedAt, inp.from, inp.to)) continue;
    const k = l.entryId ?? `${l.account}:${l.postedAt}`;
    (entries.get(k) ?? entries.set(k, []).get(k)!).push(l);
  }
  const buckets = { operating: 0, investing: 0, financing: 0 };
  for (const lines of entries.values()) {
    const cashDelta = lines.filter((l) => isCash(l.account)).reduce((n, l) => n + l.debitCents - l.creditCents, 0);
    if (cashDelta === 0) continue;
    // Classify by the non-cash counterpart carrying the most weight in the entry.
    const counterparts = lines.filter((l) => !isCash(l.account));
    let best = counterparts[0]?.account ?? 'operating';
    let bestAmt = -1;
    for (const c of counterparts) { const amt = c.debitCents + c.creditCents; if (amt > bestAmt) { bestAmt = amt; best = c.account; } }
    buckets[classifyCounterpart(best)] += cashDelta;
  }
  const net = buckets.operating + buckets.investing + buckets.financing;
  const closing = opening + net;
  const rows = [
    { section: 'Operating activities', amount: buckets.operating },
    { section: 'Investing activities', amount: buckets.investing },
    { section: 'Financing activities', amount: buckets.financing },
  ];
  return {
    key: 'cash_flow_statement', title: 'Statement of cash flows', window: { from: inp.from, to: inp.to },
    subtitle: 'Cash movement classified by counterpart: operating (rent, expenses, AR/AP), investing (non-cash assets), financing (deposits, loans, equity).',
    columns: [
      { key: 'section', label: 'Activity', kind: 'text' },
      { key: 'amount', label: 'Net cash', kind: 'money' },
    ],
    rows,
    kpis: [
      { label: 'Opening cash', value: opening, kind: 'money' },
      { label: 'Net change', value: net, kind: 'money' },
      { label: 'Closing cash', value: closing, kind: 'money' },
      { label: 'Operating', value: buckets.operating, kind: 'money' },
    ],
  };
}

/** Billed vs collected by month + the collection rate — the AR effectiveness view. */
function billingCollections(inp: ReportingInput): Report {
  const billed = new Map<string, number>();
  for (const i of inp.invoices) if (i.status !== 'void' && inWindow(i.issuedAt, inp.from, inp.to)) billed.set(monthKey(i.issuedAt), (billed.get(monthKey(i.issuedAt)) ?? 0) + i.totalCents);
  const collected = new Map<string, number>();
  for (const p of inp.payments) if (p.status !== 'void' && inWindow(p.receivedAt, inp.from, inp.to)) collected.set(monthKey(p.receivedAt), (collected.get(monthKey(p.receivedAt)) ?? 0) + p.amountCents);
  const months = [...new Set([...billed.keys(), ...collected.keys()])].sort();
  const rows = months.map((m) => {
    const b = billed.get(m) ?? 0, c = collected.get(m) ?? 0;
    return { month: m, billed: b, collected: c, rate: b > 0 ? pct(c, b) : 0 };
  });
  const bTot = sum(rows.map((r) => r.billed)), cTot = sum(rows.map((r) => r.collected));
  return {
    key: 'billing_collections', title: 'Billed vs collected', window: { from: inp.from, to: inp.to },
    columns: [
      { key: 'month', label: 'Month', kind: 'text' }, { key: 'billed', label: 'Billed', kind: 'money' },
      { key: 'collected', label: 'Collected', kind: 'money' }, { key: 'rate', label: 'Collection rate', kind: 'percent' },
    ],
    rows,
    kpis: [
      { label: 'Billed', value: bTot, kind: 'money' },
      { label: 'Collected', value: cTot, kind: 'money' },
      { label: 'Collection rate', value: bTot > 0 ? pct(cTot, bTot) : 0, kind: 'percent' },
    ],
  };
}

/** Portfolio occupancy month by month across the window. */
function occupancyTrend(inp: ReportingInput): Report {
  const active = inp.holds.filter((h) => h.status === 'active');
  const unitCount = Math.max(1, inp.units.length);
  const rows: Array<{ month: string; occupancy: number }> = [];
  // Walk month starts from `from` to `to`, clipping each month to the window.
  let cur = new Date(`${inp.from.slice(0, 7)}-01T00:00:00Z`);
  const endMs = ms(inp.to);
  while (cur.getTime() < endMs) {
    const next = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
    const clipFrom = Math.max(cur.getTime(), ms(inp.from));
    const clipTo = Math.min(next.getTime(), endMs);
    const nights = Math.round((clipTo - clipFrom) / DAY);
    if (nights > 0) {
      const f = new Date(clipFrom).toISOString().slice(0, 10);
      const t2 = new Date(clipTo).toISOString().slice(0, 10);
      const sold = sum(active.map((h) => overlapNights(h.start, h.end, f, t2)));
      rows.push({ month: cur.toISOString().slice(0, 7), occupancy: pct(sold, nights * unitCount) });
    }
    cur = next;
  }
  const latest = rows.length ? rows[rows.length - 1]!.occupancy : 0;
  return {
    key: 'occupancy_trend', title: 'Occupancy trend', window: { from: inp.from, to: inp.to },
    columns: [{ key: 'month', label: 'Month', kind: 'text' }, { key: 'occupancy', label: 'Occupancy', kind: 'percent' }],
    rows,
    kpis: [
      { label: 'Latest month', value: latest, kind: 'percent' },
      { label: 'Best month', value: rows.length ? Math.max(...rows.map((r) => r.occupancy)) : 0, kind: 'percent' },
      { label: 'Months', value: rows.length, kind: 'number' },
    ],
  };
}

const BUILDERS: Record<string, (inp: ReportingInput) => Report> = {
  occupancy, revenue, ar_aging: arAging, collections, deposits: depositsReport, payables, pipeline, portfolio, cashflow,
  rent_roll: rentRoll, delinquency, lease_expirations: leaseExpirations, box_score: boxScore, vacancy, wo_aging: woAging,
  income_statement: incomeStatement, general_ledger: generalLedger, billing_collections: billingCollections, occupancy_trend: occupancyTrend,
  owner_statement: ownerStatement, cash_flow_statement: cashFlowStatement, make_ready: makeReady, insurance_compliance: insuranceCompliance, package_room: packageRoom, waitlist_demand: waitlistDemand, owner_distributions: ownerDistributions, capital_account: capitalAccounts,
  property_budget: propertyBudgetReport,
  balance_sheet: balanceSheet, trailing_twelve: trailingTwelve, pnl_comparison: pnlComparison,
};

export function buildReport(key: string, inp: ReportingInput): Report | null {
  const fn = BUILDERS[key];
  return fn ? fn(inp) : null;
}

// --- automated insights -----------------------------------------------------

/** Scan the tenant's data and surface prioritized, explainable findings. Ordered
 *  critical → positive; deterministic given the same input. */
export function computeInsights(inp: ReportingInput): Insight[] {
  const out: Insight[] = [];
  const order: Record<InsightSeverity, number> = { critical: 0, warning: 1, info: 2, positive: 3 };

  if (!inp.ledgerBalanced) {
    out.push({ severity: 'critical', code: 'ledger_unbalanced', title: 'Ledger is out of balance', detail: 'Debits and credits do not net to zero — investigate before trusting financial reports.', action: 'Open the ledger and review recent postings.' });
  }

  const openInv = inp.invoices.filter((i) => OPEN_INV.has(i.status) && outstanding(i) > 0);
  const over30 = openInv.filter((i) => daysBetween(i.dueAt, inp.now) >= 30 && ms(i.dueAt) < ms(inp.now));
  const over90 = openInv.filter((i) => daysBetween(i.dueAt, inp.now) >= 90 && ms(i.dueAt) < ms(inp.now));
  const overdueAmt = sum(openInv.filter((i) => ms(i.dueAt) < ms(inp.now)).map(outstanding));
  if (over90.length > 0) {
    out.push({ severity: 'critical', code: 'ar_over90', params: { n: over90.length }, title: `${over90.length} invoice(s) are 90+ days overdue`, detail: `${sum(over90.map(outstanding))} in cents is severely past due — these rarely self-cure.`, metric: { value: sum(over90.map(outstanding)), kind: 'money' }, action: 'Escalate to suspension/eviction review or write-off.' });
  }
  if (over30.length > 0) {
    out.push({ severity: 'warning', code: 'ar_over30', params: { n: over30.length }, title: `${over30.length} invoice(s) are 30+ days overdue`, detail: 'Overdue receivables tie up cash and rarely improve with age.', metric: { value: sum(over30.map(outstanding)), kind: 'money' }, action: 'Run a collections sweep (Collections → Run sweep).' });
  } else if (overdueAmt > 0) {
    out.push({ severity: 'info', code: 'ar_pastdue', title: 'Some invoices are past due', detail: 'A few invoices are overdue but under 30 days — a reminder usually resolves these.', metric: { value: overdueAmt, kind: 'money' }, action: 'Send payment reminders.' });
  }

  // Occupancy (last 30 days).
  const nights = daysBetween(inp.from, inp.to) || 30;
  const active = inp.holds.filter((h) => h.status === 'active');
  const sold = sum(active.map((h) => overlapNights(h.start, h.end, inp.from, inp.to)));
  const avail = nights * Math.max(1, inp.units.length);
  const occ = pct(sold, avail);
  if (inp.units.length > 0) {
    if (occ < 40) out.push({ severity: 'warning', code: 'occ_low', params: { occ }, title: `Occupancy is ${occ}%`, detail: 'Below a healthy floor — consider lowering rates, promoting availability, or a length-of-stay discount.', metric: { value: occ, kind: 'percent' }, action: 'Review Pricing → weekend/lead-time factors.' });
    else if (occ > 85) out.push({ severity: 'positive', code: 'occ_strong', params: { occ }, title: `Occupancy is strong at ${occ}%`, detail: 'Demand is high — there may be room to raise rates without hurting fill.', metric: { value: occ, kind: 'percent' }, action: 'Consider an occupancy-tier uplift in Pricing.' });
    // Idle units.
    const occupied = new Set(active.filter((h) => overlapNights(h.start, h.end, inp.from, inp.to) > 0).map((h) => h.unitId));
    const idle = inp.units.filter((u) => u.active && !occupied.has(u.id));
    if (idle.length > 0 && idle.length < inp.units.length) {
      out.push({ severity: 'info', code: 'units_idle', params: { n: idle.length, list: `${idle.slice(0, 6).map((u) => u.label).join(', ')}${idle.length > 6 ? '…' : ''}` }, title: `${idle.length} unit(s) sat idle this window`, detail: `No booked nights for: ${idle.slice(0, 6).map((u) => u.label).join(', ')}${idle.length > 6 ? '…' : ''}.`, action: 'Check pricing/visibility for these units.' });
    }
  }

  // Deposit exposure.
  const heldExposure = sum(inp.deposits.filter((d) => d.status === 'held').map((d) => d.amountCents));
  if (heldExposure > 0) out.push({ severity: 'info', code: 'deposit_exposure', title: 'Security-deposit exposure', detail: 'Deposits held against active stays — a liability to return at move-out.', metric: { value: heldExposure, kind: 'money' } });

  // Payables due/overdue.
  const openBills = inp.bills.filter((b) => b.status !== 'void' && outstanding(b) > 0);
  const overdueBills = openBills.filter((b) => ms(b.dueAt) < ms(inp.now));
  if (overdueBills.length > 0) out.push({ severity: 'warning', code: 'bills_overdue', params: { n: overdueBills.length }, title: `${overdueBills.length} vendor bill(s) are overdue`, detail: 'Late vendor payments risk service and relationships.', metric: { value: sum(overdueBills.map(outstanding)), kind: 'money' }, action: 'Settle in Bills.' });

  // Pipeline: stalled open leads.
  const stalled = inp.leads.filter((l) => !['signed', 'lost'].includes(l.stage) && daysBetween(l.updatedAt, inp.now) >= 14);
  if (stalled.length > 0) out.push({ severity: 'warning', code: 'leads_stalled', params: { n: stalled.length }, title: `${stalled.length} lead(s) have stalled`, detail: 'Open for 14+ days with no movement — follow up before they go cold.', metric: { value: sum(stalled.map((l) => l.estValueCents)), kind: 'money' }, action: 'Advance or lose them in Pipeline.' });

  // High-priority open work orders.
  const urgentWo = inp.workOrders.filter((w) => !['completed', 'cancelled'].includes(w.status) && (w.priority === 'high' || w.priority === 'urgent'));
  if (urgentWo.length > 0) out.push({ severity: 'warning', code: 'wo_urgent', params: { n: urgentWo.length }, title: `${urgentWo.length} high-priority work order(s) open`, detail: 'Urgent maintenance is unresolved.', metric: { value: urgentWo.length, kind: 'number' }, action: 'Assign/complete in Maintenance.' });

  // Operations: units stuck in make-ready — every idle day past a week is lost rent.
  const stuckTurns = (inp.turns ?? []).filter((t) => (t.status === 'open' || t.status === 'in_progress') && t.days >= 7);
  if (stuckTurns.length > 0) out.push({ severity: 'warning', code: 'turns_stuck', params: { n: stuckTurns.length }, title: `${stuckTurns.length} unit(s) stuck in make-ready 7+ days`, detail: 'A slow turn is lost rent — every idle day is vacancy loss.', metric: { value: Math.max(...stuckTurns.map((t) => t.days)), kind: 'number' }, action: 'Push the checklist in Make-ready.' });

  // Compliance: active leases without in-force renters insurance — uninsured liability.
  if (inp.insurancePolicies) {
    const polByAg = new Map<string, PolicyLite[]>();
    for (const p of inp.insurancePolicies) { const l = polByAg.get(p.agreementId) ?? []; l.push(p); polByAg.set(p.agreementId, l); }
    const activeLeases = inp.agreements.filter((a) => a.status === 'active' && (a.kind === 'lease' || a.kind === 'monthly'));
    const uninsured = activeLeases.filter((a) => { const s = insuranceCoverage(polByAg.get(a.id) ?? [], inp.now); return s === 'none' || s === 'lapsed'; });
    const expiringSoon = activeLeases.filter((a) => insuranceCoverage(polByAg.get(a.id) ?? [], inp.now) === 'expiring');
    if (uninsured.length > 0) out.push({ severity: 'warning', code: 'ins_uninsured', params: { n: uninsured.length }, title: `${uninsured.length} lease(s) have no active renters insurance`, detail: 'Uninsured residents are a liability exposure — coverage has lapsed or was never filed.', metric: { value: uninsured.length, kind: 'number' }, action: 'Chase certificates in Insurance.' });
    else if (expiringSoon.length > 0) out.push({ severity: 'info', code: 'ins_expiring', params: { n: expiringSoon.length }, title: `${expiringSoon.length} insurance policy(ies) expire within 30 days`, detail: 'Coverage is about to lapse — request renewed certificates before it does.', metric: { value: expiringSoon.length, kind: 'number' }, action: 'Follow up in Insurance.' });
  }

  // Front desk: parcels sitting unclaimed for a week or more clog the mail room.
  const stalePackages = (inp.parcels ?? []).filter((p) => p.status !== 'picked_up' && p.daysWaiting >= 7);
  if (stalePackages.length > 0) out.push({ severity: 'info', code: 'pkg_stale', params: { n: stalePackages.length }, title: `${stalePackages.length} parcel(s) unclaimed for 7+ days`, detail: 'Packages waiting a week or more take shelf space — remind residents to collect them.', metric: { value: Math.max(...stalePackages.map((p) => p.daysWaiting)), kind: 'number' }, action: 'Re-notify recipients in Packages.' });

  // Leasing: prospects waiting for a floorplan are unmet demand — a pricing signal.
  const waiting = (inp.waitlist ?? []).filter((e) => e.status === 'waiting' || e.status === 'offered');
  if (waiting.length >= 3) out.push({ severity: 'positive', code: 'waitlist_demand', params: { n: waiting.length }, title: `${waiting.length} prospect(s) on the waitlist`, detail: 'Demand is outrunning available supply — a signal to raise asking rents or release held units.', metric: { value: waiting.length, kind: 'number' }, action: 'Review demand by floorplan in the Waitlist-demand report.' });

  // Profitability: NOI for the window from the ledger (when lines are provided).
  if (inp.ledgerLines?.length) {
    let rev = 0, exp = 0;
    for (const l of inp.ledgerLines) {
      if (!inWindow(l.postedAt, inp.from, inp.to)) continue;
      if (l.account.startsWith('revenue')) rev += l.creditCents - l.debitCents;
      else if (l.account.startsWith('expense')) exp += l.debitCents - l.creditCents;
    }
    if (rev > 0 && exp > rev) {
      out.push({ severity: 'warning', code: 'operating_loss', title: 'Operating at a loss this window', detail: 'Expenses exceeded revenue on the ledger — the portfolio lost money in this period.', metric: { value: rev - exp, kind: 'money' }, action: 'Open the Income statement report to see which accounts drove it.' });
    }
  }

  // Collection effectiveness: billed vs collected inside the window.
  const billedWin = sum(inp.invoices.filter((i) => i.status !== 'void' && inWindow(i.issuedAt, inp.from, inp.to)).map((i) => i.totalCents));
  const collectedWin = sum(inp.payments.filter((p) => p.status !== 'void' && inWindow(p.receivedAt, inp.from, inp.to)).map((p) => p.amountCents));
  if (billedWin > 0) {
    const rate = pct(collectedWin, billedWin);
    if (rate < 85) out.push({ severity: 'warning', code: 'collection_rate', params: { rate }, title: `Collection rate is ${rate}%`, detail: 'Less than 85% of what you billed this window has been collected.', metric: { value: rate, kind: 'percent' }, action: 'Review Billed vs collected, then run a collections sweep.' });
  }

  // Revenue trend vs the prior window.
  const settled = inp.payments.filter((p) => p.status !== 'void');
  const cur = sum(settled.filter((p) => inWindow(p.receivedAt, inp.from, inp.to)).map((p) => p.amountCents));
  const prev = priorWindow(inp.from, inp.to);
  const prevAmt = sum(settled.filter((p) => inWindow(p.receivedAt, prev.from, prev.to)).map((p) => p.amountCents));
  if (prevAmt > 0) {
    const delta = pct(cur - prevAmt, prevAmt);
    if (delta <= -15) out.push({ severity: 'warning', code: 'revenue_down', params: { pct: Math.abs(delta) }, title: `Revenue fell ${Math.abs(delta)}% vs the prior period`, detail: 'Collections are down window-over-window.', metric: { value: delta, kind: 'percent' } });
    else if (delta >= 15) out.push({ severity: 'positive', code: 'revenue_up', params: { pct: delta }, title: `Revenue rose ${delta}% vs the prior period`, detail: 'Cash collected grew window-over-window.', metric: { value: delta, kind: 'percent' } });
  }

  if (out.length === 0) out.push({ severity: 'positive', code: 'all_clear', title: 'Nothing needs attention', detail: 'No overdue receivables, healthy occupancy, and no stalled work — all clear for this window.' });
  // Derive the stable i18n keys from the code, so every insight carries a
  // titleKey/messageKey (and actionKey when it has an action) + params for the
  // portal to translate, with the English strings above as the fallback.
  for (const i of out) {
    if (i.code) {
      i.titleKey = `insight.${i.code}.title`;
      i.messageKey = `insight.${i.code}.detail`;
      if (i.action != null) i.actionKey = `insight.${i.code}.action`;
    }
    if (!i.params) i.params = {};
  }
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}
