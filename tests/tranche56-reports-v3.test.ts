// Tranche 56 — reports v3: the financial layer. Income statement (P&L) and
// general ledger from journal lines, billed-vs-collected with collection rate,
// monthly occupancy trend, the ledger source in the self-service builder, and
// two new insights (operating loss, low collection rate). 12 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildReport, computeInsights, REPORT_CATALOG, type ReportingInput } from '../src/reporting.ts';
import { buildCustomReport, dataSources } from '../src/report-builder.ts';
import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';

const NOW = '2026-07-11T00:00:00Z';
function input(over: Partial<ReportingInput> = {}): ReportingInput {
  return {
    now: NOW, from: '2026-06-11', to: '2026-07-12', currency: 'BRL',
    units: [{ id: 'u1', label: 'Apt 1', active: true }, { id: 'u2', label: 'Apt 2', active: true }],
    agreements: [], invoices: [], payments: [], deposits: [], bills: [], apPayments: [], leads: [], workOrders: [],
    holds: [], ledgerBalanced: true,
    ledgerLines: [
      // In-window: rent billed (DR AR / CR revenue), a maintenance bill (DR expense / CR AP).
      { account: 'assets:accounts_receivable', debitCents: 300000, creditCents: 0, postedAt: '2026-06-20T00:00:00Z' },
      { account: 'revenue:rent', debitCents: 0, creditCents: 300000, postedAt: '2026-06-20T00:00:00Z' },
      { account: 'expense:maintenance', debitCents: 120000, creditCents: 0, postedAt: '2026-07-01T00:00:00Z' },
      { account: 'liabilities:accounts_payable', debitCents: 0, creditCents: 120000, postedAt: '2026-07-01T00:00:00Z' },
      // OUT of window — must be excluded from the P&L but counted in the GL.
      { account: 'revenue:rent', debitCents: 0, creditCents: 999000, postedAt: '2026-01-05T00:00:00Z' },
      { account: 'assets:accounts_receivable', debitCents: 999000, creditCents: 0, postedAt: '2026-01-05T00:00:00Z' },
    ],
    ...over,
  };
}

test('the catalog carries the financial reports', () => {
  const keys = REPORT_CATALOG.map((r) => r.key);
  for (const k of ['income_statement', 'general_ledger', 'billing_collections', 'occupancy_trend']) assert.ok(keys.includes(k), `missing ${k}`);
});

test('income statement: revenue credit-normal, expenses debit-normal, NOI + margin', () => {
  const rep = buildReport('income_statement', input())!;
  const k = Object.fromEntries(rep.kpis.map((x) => [x.label, x.value]));
  assert.equal(k['Revenue'], 300000); // only the in-window revenue
  assert.equal(k['Expenses'], 120000);
  assert.equal(k['Net operating income'], 180000);
  assert.equal(k['Margin'], 60);
  assert.ok(rep.rows.some((r) => r['group'] === 'Income' && r['account'] === 'revenue:rent'));
  assert.ok(rep.rows.some((r) => r['group'] === 'Expense' && r['account'] === 'expense:maintenance'));
});

test('income statement excludes lines outside the window', () => {
  const rep = buildReport('income_statement', input())!;
  const rent = rep.rows.find((r) => r['account'] === 'revenue:rent')!;
  assert.equal(rent['amount'], 300000); // NOT 1299000
});

test('general ledger sums all-time debits/credits per account and nets to zero', () => {
  const rep = buildReport('general_ledger', input())!;
  const ar = rep.rows.find((r) => r['account'] === 'assets:accounts_receivable')!;
  assert.equal(ar['debits'], 1299000);
  const k = Object.fromEntries(rep.kpis.map((x) => [x.label, x.value]));
  assert.equal(k['Net (should be 0)'], 0);
});

test('billed vs collected: monthly rows + collection rate', () => {
  const inp = input({
    invoices: [
      { id: 'i1', agreementId: 'a1', issuedAt: '2026-06-15T00:00:00Z', dueAt: '2026-06-30T00:00:00Z', totalCents: 200000, paidCents: 150000, status: 'partially_paid' },
      { id: 'i2', agreementId: 'a1', issuedAt: '2026-07-02T00:00:00Z', dueAt: '2026-07-20T00:00:00Z', totalCents: 100000, paidCents: 0, status: 'open' },
    ],
    payments: [{ id: 'p1', invoiceId: 'i1', amountCents: 150000, receivedAt: '2026-06-20T00:00:00Z', status: 'recorded' }],
  });
  const rep = buildReport('billing_collections', inp)!;
  assert.deepEqual(rep.rows.map((r) => r['month']), ['2026-06', '2026-07']);
  const jun = rep.rows[0]!;
  assert.equal(jun['billed'], 200000);
  assert.equal(jun['collected'], 150000);
  assert.equal(jun['rate'], 75);
  const k = Object.fromEntries(rep.kpis.map((x) => [x.label, x.value]));
  assert.equal(k['Collection rate'], 50); // 150k of 300k
});

test('occupancy trend: chronological months with clipped windows', () => {
  const inp = input({ holds: [{ unitId: 'u1', start: '2026-06-11', end: '2026-07-12', status: 'active' }] });
  const rep = buildReport('occupancy_trend', inp)!;
  assert.deepEqual(rep.rows.map((r) => r['month']), ['2026-06', '2026-07']);
  // u1 fully booked, u2 empty → every month is 50%.
  for (const r of rep.rows) assert.equal(r['occupancy'], 50);
});

test('insight: expenses above revenue flags an operating loss', () => {
  const inp = input({ ledgerLines: [
    { account: 'revenue:rent', debitCents: 0, creditCents: 100000, postedAt: '2026-06-20T00:00:00Z' },
    { account: 'expense:maintenance', debitCents: 250000, creditCents: 0, postedAt: '2026-06-25T00:00:00Z' },
  ] });
  const ins = computeInsights(inp);
  const loss = ins.find((i) => /operating at a loss/i.test(i.title))!;
  assert.ok(loss);
  assert.equal(loss.metric!.value, -150000);
});

test('insight: a low collection rate is flagged with the rate', () => {
  const inp = input({
    invoices: [{ id: 'i1', agreementId: 'a1', issuedAt: '2026-06-15T00:00:00Z', dueAt: '2026-06-30T00:00:00Z', totalCents: 100000, paidCents: 20000, status: 'partially_paid' }],
    payments: [{ id: 'p1', invoiceId: 'i1', amountCents: 20000, receivedAt: '2026-06-20T00:00:00Z', status: 'recorded' }],
  });
  const ins = computeInsights(inp);
  assert.ok(ins.some((i) => /collection rate is 20%/i.test(i.title)));
});

test('healthy finances raise neither financial warning', () => {
  const inp = input({
    invoices: [{ id: 'i1', agreementId: 'a1', issuedAt: '2026-06-15T00:00:00Z', dueAt: '2026-06-30T00:00:00Z', totalCents: 100000, paidCents: 100000, status: 'paid' }],
    payments: [{ id: 'p1', invoiceId: 'i1', amountCents: 100000, receivedAt: '2026-06-20T00:00:00Z', status: 'recorded' }],
  });
  const ins = computeInsights(inp);
  assert.ok(!ins.some((i) => /operating at a loss|collection rate/i.test(i.title)));
});

test('report builder: the ledger source groups net by category', () => {
  const sources = dataSources();
  assert.ok(sources.some((s) => s.key === 'ledger'));
  const rep = buildCustomReport({ source: 'ledger', dimension: 'category', measure: 'net', aggregate: 'sum' }, input())!;
  const rev = rep.rows.find((r) => r.label === 'revenue')!;
  assert.equal(rev.value, -(300000 + 999000)); // credit-heavy → negative net (DR−CR)
  const assets = rep.rows.find((r) => r.label === 'assets')!;
  assert.equal(assets.value, 300000 + 999000);
});

test('report builder: ledger by month sorts chronologically', () => {
  const rep = buildCustomReport({ source: 'ledger', dimension: 'month', measure: 'debits', aggregate: 'sum' }, input())!;
  assert.deepEqual(rep.series.labels, ['2026-01', '2026-06', '2026-07']);
});

test('endpoints: income statement + GL over the seeded demo tenant', () => {
  const mgr: AuthContext = { actor: 'm', tenantId: 'jq', role: 'manager' };
  const app = new App({ authenticator: new StaticTokenAuthenticator({ mgr }), now: () => NOW });
  app.dispatch({ method: 'POST', path: '/demo/seed', bearer: 'Bearer mgr', body: {} });
  const pnl = app.dispatch({ method: 'GET', path: '/reports/income_statement', bearer: 'Bearer mgr', body: {} });
  assert.equal(pnl.status, 200);
  const k = Object.fromEntries((pnl.body as { report: { kpis: Array<{ label: string; value: number }> } }).report.kpis.map((x) => [x.label, x.value]));
  assert.ok((k['Revenue'] as number) > 0, 'seeded invoices should post revenue');
  assert.ok((k['Expenses'] as number) > 0, 'seeded bills should post expenses');
  const gl = app.dispatch({ method: 'GET', path: '/reports/general_ledger', bearer: 'Bearer mgr', body: {} });
  const gk = Object.fromEntries((gl.body as { report: { kpis: Array<{ label: string; value: number }> } }).report.kpis.map((x) => [x.label, x.value]));
  assert.equal(gk['Net (should be 0)'], 0); // the seeded ledger balances
});
