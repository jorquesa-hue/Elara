// Tranche 88 — the reporting-overhaul financial statements: balance sheet
// (assets = liabilities + equity), trailing-twelve (T-12), and the comparative
// P&L. Built over the seeded ledger; the balance sheet must net to zero.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';
import { REPORT_CATALOG, buildReport, type ReportingInput } from '../src/reporting.ts';

const NOW = '2026-07-20T00:00:00Z';
const own: AuthContext = { actor: 'own', tenantId: 'mer', role: 'owner' };
const D = (app: App, method: string, path: string, body?: Record<string, unknown>) =>
  app.dispatch({ method, path, bearer: 'Bearer own', body: body ?? {} });

function seeded() {
  const app = new App({ authenticator: new StaticTokenAuthenticator({ own }), units: [], now: () => NOW });
  D(app, 'PUT', '/config', { displayName: 'M', country: 'GB' });
  D(app, 'POST', '/demo/seed', { at: NOW });
  return app;
}

test('the three new financial statements are in the catalog', () => {
  const keys = REPORT_CATALOG.map((r) => r.key);
  for (const k of ['balance_sheet', 'trailing_twelve', 'pnl_comparison']) assert.ok(keys.includes(k), `${k} in catalog`);
});

test('balance sheet balances: assets = liabilities + equity', () => {
  const app = seeded();
  const rep = (D(app, 'GET', '/reports/balance_sheet', { from: '2025-01-01', to: '2026-08-01' }).body as { report: { kpis: Array<{ label: string; value: number }> } }).report;
  const kpi = (l: string) => rep.kpis.find((k) => k.label === l)!.value;
  assert.equal(kpi('Balances (A − L − E)'), 0, 'the sheet balances');
  assert.ok(kpi('Total assets') > 0, 'assets are positive');
  assert.equal(kpi('Total assets'), kpi('Total liabilities') + kpi('Total equity'));
});

test('trailing-twelve returns 12 months + a total row and sums NOI', () => {
  const app = seeded();
  const rep = (D(app, 'GET', '/reports/trailing_twelve', { from: '2025-08-01', to: '2026-08-01' }).body as { report: { rows: Array<{ month: string; noi: number }>; kpis: Array<{ label: string; value: number }> } }).report;
  assert.equal(rep.rows.length, 13, '12 months + total');
  assert.equal(rep.rows[12]!.month, 'T-12 total');
  const noiKpi = rep.kpis.find((k) => k.label === 'T-12 NOI')!.value;
  const monthsNoi = rep.rows.slice(0, 12).reduce((n, r) => n + r.noi, 0);
  assert.equal(noiKpi, monthsNoi, 'the KPI equals the sum of the months');
});

test('pnl comparison folds this period vs a prior window of equal length', () => {
  // Pure-engine check: revenue only in the current window → prior is zero, variance = current.
  const inp: ReportingInput = {
    tenantId: 'mer', from: '2026-07-01', to: '2026-08-01', now: NOW, currency: 'GBP',
    agreements: [], invoices: [], payments: [], bills: [], apPayments: [], leads: [], workOrders: [], deposits: [], units: [], holds: [], ledgerBalanced: true,
    ledgerLines: [
      { account: 'revenue:rent', debitCents: 0, creditCents: 100000, postedAt: '2026-07-10T00:00:00Z' },
      { account: 'expense:repairs', debitCents: 30000, creditCents: 0, postedAt: '2026-07-12T00:00:00Z' },
    ],
  } as ReportingInput;
  const rep = buildReport('pnl_comparison', inp)!;
  const noi = rep.rows.find((r) => (r as { line: string }).line === 'Net operating income') as { current: number; prior: number; variance: number };
  assert.equal(noi.current, 70000);
  assert.equal(noi.prior, 0);
  assert.equal(noi.variance, 70000);
});
