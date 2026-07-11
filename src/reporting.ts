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
  units: ReadonlyArray<{ id: string; label: string; active: boolean }>;
  agreements: ReadonlyArray<{ id: string; kind: string; status: string; unitId: string; start: string; end: string; rateCents: number }>;
  invoices: ReadonlyArray<{ id: string; agreementId: string; issuedAt: string; dueAt: string; totalCents: number; paidCents: number; status: string }>;
  payments: ReadonlyArray<{ id: string; invoiceId: string; amountCents: number; receivedAt: string; status: string }>;
  deposits: ReadonlyArray<{ id: string; agreementId: string; amountCents: number; status: string; heldAt: string; refundedCents?: number | null }>;
  bills: ReadonlyArray<{ id: string; payeeId: string; totalCents: number; paidCents: number; status: string; issuedAt: string; dueAt: string }>;
  apPayments: ReadonlyArray<{ id: string; billId: string; amountCents: number; paidAt: string; status: string }>;
  leads: ReadonlyArray<{ id: string; stage: string; estValueCents: number; createdAt: string; updatedAt: string }>;
  workOrders: ReadonlyArray<{ id: string; status: string; priority: string; openedAt: string }>;
  holds: ReadonlyArray<{ unitId: string; start: string; end: string; status: string }>;
  ledgerBalanced: boolean;
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
}

export interface ReportSpec { key: string; title: string; description: string }
export const REPORT_CATALOG: readonly ReportSpec[] = [
  { key: 'occupancy', title: 'Occupancy', description: 'Sold vs available room-nights per unit for the window.' },
  { key: 'revenue', title: 'Revenue & ADR', description: 'Cash collected, ADR and RevPAR, by month.' },
  { key: 'ar_aging', title: 'Receivables aging', description: 'Outstanding invoices bucketed by days overdue.' },
  { key: 'collections', title: 'Collections', description: 'Every past-due invoice with days overdue and outstanding balance.' },
  { key: 'deposits', title: 'Security deposits', description: 'Held vs refunded, and current exposure.' },
  { key: 'payables', title: 'Accounts payable', description: 'Vendor bills outstanding, aged by due date.' },
  { key: 'pipeline', title: 'Sales pipeline', description: 'Leads by stage, pipeline value and conversion.' },
  { key: 'portfolio', title: 'Portfolio mix', description: 'Agreements by kind and status; unit occupancy mix.' },
  { key: 'cashflow', title: 'Cash flow', description: 'Money in (payments) vs money out (vendor payouts) for the window.' },
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

const BUILDERS: Record<string, (inp: ReportingInput) => Report> = {
  occupancy, revenue, ar_aging: arAging, collections, deposits: depositsReport, payables, pipeline, portfolio, cashflow,
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
    out.push({ severity: 'critical', title: 'Ledger is out of balance', detail: 'Debits and credits do not net to zero — investigate before trusting financial reports.', action: 'Open the ledger and review recent postings.' });
  }

  const openInv = inp.invoices.filter((i) => OPEN_INV.has(i.status) && outstanding(i) > 0);
  const over30 = openInv.filter((i) => daysBetween(i.dueAt, inp.now) >= 30 && ms(i.dueAt) < ms(inp.now));
  const over90 = openInv.filter((i) => daysBetween(i.dueAt, inp.now) >= 90 && ms(i.dueAt) < ms(inp.now));
  const overdueAmt = sum(openInv.filter((i) => ms(i.dueAt) < ms(inp.now)).map(outstanding));
  if (over90.length > 0) {
    out.push({ severity: 'critical', title: `${over90.length} invoice(s) are 90+ days overdue`, detail: `${sum(over90.map(outstanding))} in cents is severely past due — these rarely self-cure.`, metric: { value: sum(over90.map(outstanding)), kind: 'money' }, action: 'Escalate to suspension/eviction review or write-off.' });
  }
  if (over30.length > 0) {
    out.push({ severity: 'warning', title: `${over30.length} invoice(s) are 30+ days overdue`, detail: 'Overdue receivables tie up cash and rarely improve with age.', metric: { value: sum(over30.map(outstanding)), kind: 'money' }, action: 'Run a collections sweep (Collections → Run sweep).' });
  } else if (overdueAmt > 0) {
    out.push({ severity: 'info', title: 'Some invoices are past due', detail: 'A few invoices are overdue but under 30 days — a reminder usually resolves these.', metric: { value: overdueAmt, kind: 'money' }, action: 'Send payment reminders.' });
  }

  // Occupancy (last 30 days).
  const nights = daysBetween(inp.from, inp.to) || 30;
  const active = inp.holds.filter((h) => h.status === 'active');
  const sold = sum(active.map((h) => overlapNights(h.start, h.end, inp.from, inp.to)));
  const avail = nights * Math.max(1, inp.units.length);
  const occ = pct(sold, avail);
  if (inp.units.length > 0) {
    if (occ < 40) out.push({ severity: 'warning', title: `Occupancy is ${occ}%`, detail: 'Below a healthy floor — consider lowering rates, promoting availability, or a length-of-stay discount.', metric: { value: occ, kind: 'percent' }, action: 'Review Pricing → weekend/lead-time factors.' });
    else if (occ > 85) out.push({ severity: 'positive', title: `Occupancy is strong at ${occ}%`, detail: 'Demand is high — there may be room to raise rates without hurting fill.', metric: { value: occ, kind: 'percent' }, action: 'Consider an occupancy-tier uplift in Pricing.' });
    // Idle units.
    const occupied = new Set(active.filter((h) => overlapNights(h.start, h.end, inp.from, inp.to) > 0).map((h) => h.unitId));
    const idle = inp.units.filter((u) => u.active && !occupied.has(u.id));
    if (idle.length > 0 && idle.length < inp.units.length) {
      out.push({ severity: 'info', title: `${idle.length} unit(s) sat idle this window`, detail: `No booked nights for: ${idle.slice(0, 6).map((u) => u.label).join(', ')}${idle.length > 6 ? '…' : ''}.`, action: 'Check pricing/visibility for these units.' });
    }
  }

  // Deposit exposure.
  const heldExposure = sum(inp.deposits.filter((d) => d.status === 'held').map((d) => d.amountCents));
  if (heldExposure > 0) out.push({ severity: 'info', title: 'Security-deposit exposure', detail: 'Deposits held against active stays — a liability to return at move-out.', metric: { value: heldExposure, kind: 'money' } });

  // Payables due/overdue.
  const openBills = inp.bills.filter((b) => b.status !== 'void' && outstanding(b) > 0);
  const overdueBills = openBills.filter((b) => ms(b.dueAt) < ms(inp.now));
  if (overdueBills.length > 0) out.push({ severity: 'warning', title: `${overdueBills.length} vendor bill(s) are overdue`, detail: 'Late vendor payments risk service and relationships.', metric: { value: sum(overdueBills.map(outstanding)), kind: 'money' }, action: 'Settle in Bills.' });

  // Pipeline: stalled open leads.
  const stalled = inp.leads.filter((l) => !['signed', 'lost'].includes(l.stage) && daysBetween(l.updatedAt, inp.now) >= 14);
  if (stalled.length > 0) out.push({ severity: 'warning', title: `${stalled.length} lead(s) have stalled`, detail: 'Open for 14+ days with no movement — follow up before they go cold.', metric: { value: sum(stalled.map((l) => l.estValueCents)), kind: 'money' }, action: 'Advance or lose them in Pipeline.' });

  // High-priority open work orders.
  const urgentWo = inp.workOrders.filter((w) => !['completed', 'cancelled'].includes(w.status) && (w.priority === 'high' || w.priority === 'urgent'));
  if (urgentWo.length > 0) out.push({ severity: 'warning', title: `${urgentWo.length} high-priority work order(s) open`, detail: 'Urgent maintenance is unresolved.', metric: { value: urgentWo.length, kind: 'number' }, action: 'Assign/complete in Maintenance.' });

  // Revenue trend vs the prior window.
  const settled = inp.payments.filter((p) => p.status !== 'void');
  const cur = sum(settled.filter((p) => inWindow(p.receivedAt, inp.from, inp.to)).map((p) => p.amountCents));
  const prev = priorWindow(inp.from, inp.to);
  const prevAmt = sum(settled.filter((p) => inWindow(p.receivedAt, prev.from, prev.to)).map((p) => p.amountCents));
  if (prevAmt > 0) {
    const delta = pct(cur - prevAmt, prevAmt);
    if (delta <= -15) out.push({ severity: 'warning', title: `Revenue fell ${Math.abs(delta)}% vs the prior period`, detail: 'Collections are down window-over-window.', metric: { value: delta, kind: 'percent' } });
    else if (delta >= 15) out.push({ severity: 'positive', title: `Revenue rose ${delta}% vs the prior period`, detail: 'Cash collected grew window-over-window.', metric: { value: delta, kind: 'percent' } });
  }

  if (out.length === 0) out.push({ severity: 'positive', title: 'Nothing needs attention', detail: 'No overdue receivables, healthy occupancy, and no stalled work — all clear for this window.' });
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}
