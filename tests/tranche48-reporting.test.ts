// Tranche 48 — Reporting & insights. The self-service report catalog + builders,
// and the automated insight feed (prioritized, explainable findings). Pure engine
// tested directly, plus the /reports endpoints over an App. 11 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildReport, computeInsights, REPORT_CATALOG, type ReportingInput } from '../src/reporting.ts';
import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';

const NOW = '2026-07-11T00:00:00Z';
const FROM = '2026-06-11';
const TO = '2026-07-12';

// A compact but exercised world: one paid + one open-overdue invoice, an active
// hold, a held deposit, an overdue bill, a stalled lead, an urgent work order.
function baseInput(over: Partial<ReportingInput> = {}): ReportingInput {
  return {
    now: NOW, from: FROM, to: TO, currency: 'BRL',
    units: [{ id: 'u1', label: 'Apt 1', active: true }, { id: 'u2', label: 'Apt 2', active: true }],
    agreements: [{ id: 'a1', kind: 'nightly', status: 'active', unitId: 'u1', start: '2026-07-08', end: '2026-07-15', rateCents: 50000 }],
    invoices: [
      { id: 'i-paid', agreementId: 'a1', issuedAt: '2026-07-01T00:00:00Z', dueAt: '2026-07-05T00:00:00Z', totalCents: 50000, paidCents: 50000, status: 'paid' },
      { id: 'i-overdue', agreementId: 'a1', issuedAt: '2026-05-01T00:00:00Z', dueAt: '2026-05-20T00:00:00Z', totalCents: 30000, paidCents: 0, status: 'open' },
    ],
    payments: [{ id: 'p1', invoiceId: 'i-paid', amountCents: 50000, receivedAt: '2026-07-03T00:00:00Z', status: 'recorded' }],
    deposits: [{ id: 'd1', agreementId: 'a1', amountCents: 100000, status: 'held', heldAt: '2026-07-01T00:00:00Z' }],
    bills: [{ id: 'b1', payeeId: 'v1', totalCents: 20000, paidCents: 0, status: 'open', issuedAt: '2026-06-01T00:00:00Z', dueAt: '2026-06-20T00:00:00Z' }],
    apPayments: [],
    leads: [{ id: 'l1', stage: 'toured', estValueCents: 200000, createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z' }],
    workOrders: [{ id: 'w1', status: 'open', priority: 'urgent', openedAt: '2026-07-09T00:00:00Z' }],
    holds: [{ unitId: 'u1', start: '2026-07-08', end: '2026-07-15', status: 'active' }],
    ledgerBalanced: true,
    ...over,
  };
}

test('the report catalog covers the expected reports', () => {
  const keys = REPORT_CATALOG.map((r) => r.key);
  for (const k of ['occupancy', 'revenue', 'ar_aging', 'collections', 'deposits', 'payables', 'pipeline', 'portfolio', 'cashflow']) {
    assert.ok(keys.includes(k), `catalog missing ${k}`);
  }
});

test('every catalog report builds against a valid input', () => {
  const inp = baseInput();
  for (const spec of REPORT_CATALOG) {
    const rep = buildReport(spec.key, inp);
    assert.ok(rep, `report ${spec.key} did not build`);
    assert.equal(rep!.key, spec.key);
    assert.ok(Array.isArray(rep!.rows));
    assert.ok(Array.isArray(rep!.kpis));
  }
});

test('unknown report key returns null', () => {
  assert.equal(buildReport('does_not_exist', baseInput()), null);
});

test('revenue report sums only in-window settled payments', () => {
  const rep = buildReport('revenue', baseInput())!;
  const revKpi = rep.kpis.find((k) => k.label === 'Revenue')!;
  assert.equal(revKpi.value, 50000);
});

test('AR aging separates the overdue invoice from the paid one', () => {
  const rep = buildReport('ar_aging', baseInput())!;
  const overdueKpi = rep.kpis.find((k) => k.label === 'Overdue')!;
  assert.equal(overdueKpi.value, 30000); // only the open invoice is outstanding
  const openKpi = rep.kpis.find((k) => k.label === 'Open invoices')!;
  assert.equal(openKpi.value, 1);
});

test('collections report lists the past-due invoice with days overdue', () => {
  const rep = buildReport('collections', baseInput())!;
  assert.equal(rep.rows.length, 1);
  assert.equal((rep.rows[0] as { invoice: string }).invoice, 'i-overdue');
  assert.ok((rep.rows[0] as { daysOverdue: number }).daysOverdue > 30);
});

test('cashflow nets money-in against money-out', () => {
  const inp = baseInput({ apPayments: [{ id: 'ap1', billId: 'b1', amountCents: 12000, paidAt: '2026-07-02T00:00:00Z', status: 'recorded' }] });
  const rep = buildReport('cashflow', inp)!;
  assert.equal(rep.kpis.find((k) => k.label === 'Net cash')!.value, 50000 - 12000);
});

test('insights flag 30+ day overdue AR with a collections action', () => {
  const ins = computeInsights(baseInput());
  const overdue = ins.find((i) => /overdue/i.test(i.title) && i.severity === 'warning');
  assert.ok(overdue, 'expected an overdue-AR warning');
  assert.match(overdue!.action ?? '', /collections/i);
});

test('an unbalanced ledger is the top-priority critical insight', () => {
  const ins = computeInsights(baseInput({ ledgerBalanced: false }));
  assert.equal(ins[0]!.severity, 'critical');
  assert.match(ins[0]!.title, /balance/i);
});

test('a clean world reports nothing needs attention', () => {
  const clean: ReportingInput = {
    now: NOW, from: FROM, to: TO, currency: 'BRL',
    units: [], agreements: [], invoices: [], payments: [], deposits: [], bills: [], apPayments: [],
    leads: [], workOrders: [], holds: [],
    ledgerBalanced: true,
  };
  const ins = computeInsights(clean);
  assert.equal(ins.length, 1);
  assert.equal(ins[0]!.severity, 'positive');
  assert.match(ins[0]!.title, /nothing needs attention/i);
});

test('GET /reports/:key and /reports/insights are reachable (reports.read)', () => {
  const ro: AuthContext = { actor: 'r', tenantId: 't1', role: 'read_only' };
  const app = new App({ authenticator: new StaticTokenAuthenticator({ ro }), now: () => NOW });
  const cat = app.dispatch({ method: 'GET', path: '/reports/catalog', bearer: 'Bearer ro' });
  assert.equal(cat.status, 200);
  const rep = app.dispatch({ method: 'GET', path: '/reports/occupancy', bearer: 'Bearer ro' });
  assert.equal(rep.status, 200);
  assert.ok((rep.body as { report: unknown }).report);
  assert.ok(Array.isArray((rep.body as { insights: unknown[] }).insights));
  const ins = app.dispatch({ method: 'GET', path: '/reports/insights', bearer: 'Bearer ro' });
  assert.equal(ins.status, 200);
});
