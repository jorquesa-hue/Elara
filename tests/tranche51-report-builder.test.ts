// Tranche 51 — Self-service report builder. Pick a source, a group-by dimension,
// a measure + aggregate, an optional filter, and a chart type; get grouped,
// chart-ready rows. Pure engine + the /reports/build endpoints. 10 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildCustomReport, dataSources, type CustomReportSpec } from '../src/report-builder.ts';
import type { ReportingInput } from '../src/reporting.ts';
import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';

const NOW = '2026-07-11T00:00:00Z';
function input(over: Partial<ReportingInput> = {}): ReportingInput {
  return {
    now: NOW, from: '2026-06-11', to: '2026-07-12', currency: 'BRL',
    units: [{ id: 'u1', label: 'Apt 1', active: true }, { id: 'u2', label: 'Apt 2', active: true }],
    agreements: [
      { id: 'a1', kind: 'nightly', status: 'active', unitId: 'u1', start: '2026-07-01', end: '2026-07-06', rateCents: 50000 },
      { id: 'a2', kind: 'nightly', status: 'active', unitId: 'u2', start: '2026-07-02', end: '2026-07-04', rateCents: 40000 },
      { id: 'a3', kind: 'lease', status: 'draft', unitId: 'u1', start: '2026-06-01', end: '2027-06-01', rateCents: 300000 },
    ],
    invoices: [
      { id: 'i1', agreementId: 'a1', issuedAt: '2026-07-01T00:00:00Z', dueAt: '2026-07-05T00:00:00Z', totalCents: 50000, paidCents: 50000, status: 'paid' },
      { id: 'i2', agreementId: 'a3', issuedAt: '2026-06-10T00:00:00Z', dueAt: '2026-06-20T00:00:00Z', totalCents: 30000, paidCents: 0, status: 'open' },
    ],
    payments: [{ id: 'p1', invoiceId: 'i1', amountCents: 50000, receivedAt: '2026-07-03T00:00:00Z', status: 'recorded' }],
    deposits: [{ id: 'd1', agreementId: 'a3', amountCents: 100000, status: 'held', heldAt: '2026-06-01T00:00:00Z' }],
    bills: [{ id: 'b1', payeeId: 'v1', totalCents: 20000, paidCents: 0, status: 'open', issuedAt: '2026-06-05T00:00:00Z', dueAt: '2026-06-20T00:00:00Z' }],
    apPayments: [], leads: [
      { id: 'l1', stage: 'toured', estValueCents: 200000, createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z' },
      { id: 'l2', stage: 'signed', estValueCents: 500000, createdAt: '2026-06-15T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z' },
    ],
    workOrders: [{ id: 'w1', status: 'open', priority: 'urgent', openedAt: '2026-07-09T00:00:00Z' }],
    holds: [], ledgerBalanced: true, ...over,
  };
}

test('dataSources exposes sources with dimensions, measures (incl. count), filters', () => {
  const sources = dataSources();
  const ag = sources.find((s) => s.key === 'agreements')!;
  assert.ok(ag.dimensions.some((d) => d.key === 'kind'));
  assert.ok(ag.measures.some((m) => m.key === 'count'));
  assert.ok(ag.filters.some((f) => f.key === 'status'));
});

test('count of agreements grouped by kind', () => {
  const rep = buildCustomReport({ source: 'agreements', dimension: 'kind', measure: 'count' }, input())!;
  const nightly = rep.rows.find((r) => r.label === 'nightly')!;
  assert.equal(nightly.value, 2);
  assert.equal(rep.rows.find((r) => r.label === 'lease')!.value, 1);
  assert.equal(rep.valueKind, 'number');
});

test('sum of rate by unit relabels unit ids to unit labels', () => {
  const rep = buildCustomReport({ source: 'agreements', dimension: 'unit', measure: 'rate', aggregate: 'sum' }, input())!;
  const apt1 = rep.rows.find((r) => r.label === 'Apt 1')!; // a1 (50000) + a3 (300000)
  assert.equal(apt1.value, 350000);
  assert.equal(rep.valueKind, 'money');
});

test('average aggregate divides sum by group count', () => {
  const rep = buildCustomReport({ source: 'agreements', dimension: 'kind', measure: 'rate', aggregate: 'avg' }, input())!;
  const nightly = rep.rows.find((r) => r.label === 'nightly')!; // (50000+40000)/2
  assert.equal(nightly.value, 45000);
});

test('a filter restricts the rows before grouping', () => {
  const rep = buildCustomReport({ source: 'agreements', dimension: 'kind', measure: 'count', filterKey: 'status', filterValue: 'active' }, input())!;
  assert.equal(rep.rows.length, 1); // only nightly (2 active); the draft lease is filtered out
  assert.equal(rep.rows[0]!.label, 'nightly');
  assert.equal(rep.rows[0]!.value, 2);
});

test('invoices outstanding by status sums total minus paid', () => {
  const rep = buildCustomReport({ source: 'invoices', dimension: 'status', measure: 'outstanding', aggregate: 'sum' }, input())!;
  assert.equal(rep.rows.find((r) => r.label === 'open')!.value, 30000);
  assert.equal(rep.rows.find((r) => r.label === 'paid')!.value, 0);
});

test('a time dimension sorts chronologically and defaults to a line chart', () => {
  const rep = buildCustomReport({ source: 'payments', dimension: 'month', measure: 'amount' }, input())!;
  assert.equal(rep.chart, 'line');
  assert.deepEqual(rep.series.labels, ['2026-07']);
});

test('series is chart-ready (labels align with values)', () => {
  const rep = buildCustomReport({ source: 'leads', dimension: 'stage', measure: 'est', aggregate: 'sum', chart: 'donut' }, input())!;
  assert.equal(rep.series.labels.length, rep.series.values.length);
  assert.equal(rep.chart, 'donut');
  const total = rep.kpis.find((k) => /Total/.test(k.label))!;
  assert.equal(total.value, 700000); // 200000 + 500000
});

test('an unknown source or dimension returns null', () => {
  assert.equal(buildCustomReport({ source: 'nope', dimension: 'x' }, input()), null);
  assert.equal(buildCustomReport({ source: 'agreements', dimension: 'nope' }, input()), null);
});

test('endpoints: GET /reports/build/sources and POST /reports/build (reports.read)', () => {
  const mgr: AuthContext = { actor: 'm', tenantId: 'jq', role: 'manager' };
  const app = new App({ authenticator: new StaticTokenAuthenticator({ mgr }), now: () => NOW });
  app.dispatch({ method: 'POST', path: '/demo/seed', bearer: 'Bearer mgr', body: {} });
  const sources = app.dispatch({ method: 'GET', path: '/reports/build/sources', bearer: 'Bearer mgr', body: {} });
  assert.equal(sources.status, 200);
  assert.ok((sources.body as { sources: unknown[] }).sources.length >= 5);
  const spec: CustomReportSpec = { source: 'agreements', dimension: 'kind', measure: 'count', chart: 'bar' };
  const built = app.dispatch({ method: 'POST', path: '/reports/build', bearer: 'Bearer mgr', body: spec as unknown as Record<string, unknown> });
  assert.equal(built.status, 200);
  const rep = (built.body as { report: { rows: unknown[]; series: { values: number[] } } }).report;
  assert.ok(rep.rows.length >= 2); // nightly + monthly + lease in the demo world
  assert.ok(rep.series.values.length >= 2);
});
