// Self-service report builder — the "pick your own" analytics layer on top of the
// fixed report catalog. A pure, zero-dep query engine: choose a DATA SOURCE
// (agreements, invoices, payments, bills, leads, work orders, deposits), a
// DIMENSION to group by, a MEASURE to aggregate (count / sum / average), an
// optional FILTER, and a CHART type. buildCustomReport folds the tenant's own
// data into grouped rows + a chart-ready series, so the portal can render a bar,
// line, or donut without any server round-trip logic leaking into the client.
//
// It reuses the same ReportingInput slice the catalog reports run on, so nothing
// new needs gathering — every source is already in memory.

import type { ReportingInput } from './reporting.ts';

export type Aggregate = 'count' | 'sum' | 'avg';
export type ChartType = 'bar' | 'line' | 'donut' | 'table' | 'kpi';
export type ValueKind = 'money' | 'number';

interface Dimension { key: string; label: string; get: (row: Record<string, unknown>) => string; time?: boolean }
interface Measure { key: string; label: string; kind: ValueKind; get?: (row: Record<string, unknown>) => number }
interface Source {
  key: string; label: string;
  rows: (inp: ReportingInput) => Record<string, unknown>[];
  dimensions: Dimension[];
  measures: Measure[]; // 'count' is always available implicitly
  filters?: { key: string; label: string; options: string[]; get: (row: Record<string, unknown>) => string }[];
}

const monthKey = (d: unknown) => (typeof d === 'string' && d.length >= 7 ? d.slice(0, 7) : '—');
const outstanding = (r: Record<string, unknown>) => Math.max(0, Number(r['totalCents'] || 0) - Number(r['paidCents'] || 0));

// A label resolver for unit ids → unit labels, bound per build (units live in the input).
function unitLabeller(inp: ReportingInput): (id: unknown) => string {
  const byId = new Map(inp.units.map((u) => [u.id, u.label]));
  return (id) => byId.get(String(id)) ?? String(id ?? '—');
}

export function dataSources(): Array<{ key: string; label: string; dimensions: { key: string; label: string }[]; measures: { key: string; label: string; kind: ValueKind }[]; filters: { key: string; label: string; options: string[] }[] }> {
  return SOURCES.map((s) => ({
    key: s.key, label: s.label,
    dimensions: s.dimensions.map((d) => ({ key: d.key, label: d.label })),
    measures: [{ key: 'count', label: 'Count', kind: 'number' as ValueKind }, ...s.measures.map((m) => ({ key: m.key, label: m.label, kind: m.kind }))],
    filters: (s.filters ?? []).map((f) => ({ key: f.key, label: f.label, options: f.options })),
  }));
}

const SOURCES: Source[] = [
  {
    key: 'agreements', label: 'Agreements',
    rows: (i) => i.agreements as unknown as Record<string, unknown>[],
    dimensions: [
      { key: 'kind', label: 'Kind', get: (r) => String(r['kind']) },
      { key: 'status', label: 'Status', get: (r) => String(r['status']) },
      { key: 'unit', label: 'Unit', get: (r) => String(r['unitId']) }, // relabelled at build time
      { key: 'startMonth', label: 'Start month', get: (r) => monthKey(r['start']), time: true },
    ],
    measures: [
      { key: 'rate', label: 'Rate (sum)', kind: 'money', get: (r) => Number(r['rateCents'] || 0) },
    ],
    filters: [
      { key: 'status', label: 'Status', options: ['draft', 'active', 'completed', 'terminated'], get: (r) => String(r['status']) },
      { key: 'kind', label: 'Kind', options: ['nightly', 'monthly', 'lease'], get: (r) => String(r['kind']) },
    ],
  },
  {
    key: 'invoices', label: 'Invoices (AR)',
    rows: (i) => i.invoices as unknown as Record<string, unknown>[],
    dimensions: [
      { key: 'status', label: 'Status', get: (r) => String(r['status']) },
      { key: 'issuedMonth', label: 'Issued month', get: (r) => monthKey(r['issuedAt']), time: true },
    ],
    measures: [
      { key: 'total', label: 'Billed (sum)', kind: 'money', get: (r) => Number(r['totalCents'] || 0) },
      { key: 'paid', label: 'Collected (sum)', kind: 'money', get: (r) => Number(r['paidCents'] || 0) },
      { key: 'outstanding', label: 'Outstanding (sum)', kind: 'money', get: outstanding },
    ],
    filters: [{ key: 'status', label: 'Status', options: ['open', 'partially_paid', 'paid', 'void'], get: (r) => String(r['status']) }],
  },
  {
    key: 'payments', label: 'Payments',
    rows: (i) => i.payments as unknown as Record<string, unknown>[],
    dimensions: [
      { key: 'status', label: 'Status', get: (r) => String(r['status']) },
      { key: 'month', label: 'Month received', get: (r) => monthKey(r['receivedAt']), time: true },
    ],
    measures: [{ key: 'amount', label: 'Amount (sum)', kind: 'money', get: (r) => Number(r['amountCents'] || 0) }],
  },
  {
    key: 'bills', label: 'Bills (AP)',
    rows: (i) => i.bills as unknown as Record<string, unknown>[],
    dimensions: [
      { key: 'status', label: 'Status', get: (r) => String(r['status']) },
      { key: 'issuedMonth', label: 'Issued month', get: (r) => monthKey(r['issuedAt']), time: true },
    ],
    measures: [
      { key: 'total', label: 'Billed (sum)', kind: 'money', get: (r) => Number(r['totalCents'] || 0) },
      { key: 'outstanding', label: 'Outstanding (sum)', kind: 'money', get: outstanding },
    ],
  },
  {
    key: 'leads', label: 'Leads (CRM)',
    rows: (i) => i.leads as unknown as Record<string, unknown>[],
    dimensions: [
      { key: 'stage', label: 'Stage', get: (r) => String(r['stage']) },
      { key: 'month', label: 'Created month', get: (r) => monthKey(r['createdAt']), time: true },
    ],
    measures: [{ key: 'est', label: 'Est. value (sum)', kind: 'money', get: (r) => Number(r['estValueCents'] || 0) }],
    filters: [{ key: 'stage', label: 'Stage', options: ['new', 'toured', 'applied', 'approved', 'signed', 'lost'], get: (r) => String(r['stage']) }],
  },
  {
    key: 'workOrders', label: 'Work orders',
    rows: (i) => i.workOrders as unknown as Record<string, unknown>[],
    dimensions: [
      { key: 'status', label: 'Status', get: (r) => String(r['status']) },
      { key: 'priority', label: 'Priority', get: (r) => String(r['priority']) },
      { key: 'month', label: 'Opened month', get: (r) => monthKey(r['openedAt']), time: true },
    ],
    measures: [],
    filters: [{ key: 'priority', label: 'Priority', options: ['low', 'normal', 'high', 'urgent'], get: (r) => String(r['priority']) }],
  },
  {
    key: 'deposits', label: 'Deposits',
    rows: (i) => i.deposits as unknown as Record<string, unknown>[],
    dimensions: [
      { key: 'status', label: 'Status', get: (r) => String(r['status']) },
      { key: 'month', label: 'Held month', get: (r) => monthKey(r['heldAt']), time: true },
    ],
    measures: [{ key: 'amount', label: 'Amount (sum)', kind: 'money', get: (r) => Number(r['amountCents'] || 0) }],
  },
];

export interface CustomReportSpec {
  source: string;
  dimension: string;
  measure?: string; // omit or 'count' → row count
  aggregate?: Aggregate; // sum (default) or avg for a numeric measure; ignored for count
  chart?: ChartType;
  filterKey?: string;
  filterValue?: string;
  limit?: number; // top-N groups (default 20)
}

export interface CustomReport {
  title: string;
  source: string;
  dimensionLabel: string;
  measureLabel: string;
  valueKind: ValueKind;
  chart: ChartType;
  columns: Array<{ key: string; label: string; kind: 'text' | 'money' | 'number' }>;
  rows: Array<{ label: string; value: number }>;
  series: { labels: string[]; values: number[]; valueKind: ValueKind };
  kpis: Array<{ label: string; value: number; kind: ValueKind }>;
}

/** Build a grouped, aggregated, chart-ready report from a spec over the input. */
export function buildCustomReport(spec: CustomReportSpec, inp: ReportingInput): CustomReport | null {
  const src = SOURCES.find((s) => s.key === spec.source);
  if (!src) return null;
  const dim = src.dimensions.find((d) => d.key === spec.dimension);
  if (!dim) return null;
  const measureKey = spec.measure && spec.measure !== 'count' ? spec.measure : 'count';
  const measure = measureKey === 'count' ? null : src.measures.find((m) => m.key === measureKey);
  if (measureKey !== 'count' && !measure) return null;
  const aggregate: Aggregate = measureKey === 'count' ? 'count' : (spec.aggregate ?? 'sum');
  const valueKind: ValueKind = measure ? measure.kind : 'number';

  let rows = src.rows(inp);
  if (spec.filterKey && spec.filterValue) {
    const f = (src.filters ?? []).find((x) => x.key === spec.filterKey);
    if (f) rows = rows.filter((r) => f.get(r) === spec.filterValue);
  }

  // Group + aggregate.
  const label = dim.key === 'unit' ? unitLabeller(inp) : (v: unknown) => String(v);
  const groups = new Map<string, { sum: number; count: number }>();
  for (const r of rows) {
    const key = dim.key === 'unit' ? label(dim.get(r)) : dim.get(r);
    const g = groups.get(key) ?? { sum: 0, count: 0 };
    g.count += 1;
    if (measure?.get) g.sum += measure.get(r);
    groups.set(key, g);
  }

  let out = [...groups.entries()].map(([k, g]) => ({
    label: k,
    value: aggregate === 'count' ? g.count : aggregate === 'avg' ? (g.count ? Math.round(g.sum / g.count) : 0) : g.sum,
  }));

  // Time dimensions sort chronologically; everything else by value desc.
  if (dim.time) out.sort((a, b) => a.label.localeCompare(b.label));
  else out.sort((a, b) => b.value - a.value);
  const limit = spec.limit && spec.limit > 0 ? spec.limit : 20;
  if (out.length > limit) out = out.slice(0, limit);

  const measureLabel = measureKey === 'count' ? 'Count' : `${measure!.label.replace(/ \((sum|avg)\)$/i, '')} (${aggregate})`;
  const chart: ChartType = spec.chart ?? (dim.time ? 'line' : 'bar');
  const total = out.reduce((s, r) => s + r.value, 0);

  return {
    title: `${src.label} — ${measureLabel} by ${dim.label}`,
    source: src.key,
    dimensionLabel: dim.label,
    measureLabel,
    valueKind,
    chart,
    columns: [
      { key: 'label', label: dim.label, kind: 'text' },
      { key: 'value', label: measureLabel, kind: aggregate === 'count' ? 'number' : valueKind },
    ],
    rows: out,
    series: { labels: out.map((r) => r.label), values: out.map((r) => r.value), valueKind: aggregate === 'count' ? 'number' : valueKind },
    kpis: [
      { label: aggregate === 'count' ? 'Total records' : `Total ${measureLabel}`, value: total, kind: aggregate === 'count' ? 'number' : valueKind },
      { label: `${dim.label} groups`, value: out.length, kind: 'number' },
    ],
  };
}
