// Tranche 52 — property-management staple reports (the RealPage/Entrata-class
// operational set): rent roll, delinquency aging by resident, lease expirations,
// box score, vacancy & availability, work-order aging. Pure builders over a
// hand-built world + the endpoint over the seeded demo tenant. 11 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildReport, REPORT_CATALOG, type ReportingInput } from '../src/reporting.ts';
import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';

const NOW = '2026-07-11T00:00:00Z';
// A small but fully-exercised world:
//  u1 occupied (Alice, lease, deposit held, one 45-day-overdue + one current invoice)
//  u2 vacant since 2026-07-01 (prior monthly ended; a future lease signed for it)
//  u3 vacant, never occupied
//  u4 inactive (offline)
//  u5 occupied (Bob, nightly stay that started inside the window)
function world(): ReportingInput {
  return {
    now: NOW, from: '2026-06-11', to: '2026-07-12', currency: 'BRL',
    units: [
      { id: 'u1', label: 'Apt 101', active: true },
      { id: 'u2', label: 'Apt 102', active: true },
      { id: 'u3', label: 'Apt 103', active: true },
      { id: 'u4', label: 'Apt 104 (reforma)', active: false },
      { id: 'u5', label: 'Casa Praia', active: true },
    ],
    agreements: [
      { id: 'a1', kind: 'lease', status: 'active', unitId: 'u1', start: '2026-04-02', end: '2027-03-18', rateCents: 200000, residentName: 'Alice Souza' },
      { id: 'a2', kind: 'monthly', status: 'completed', unitId: 'u2', start: '2026-01-01', end: '2026-07-01', rateCents: 180000, residentName: 'Carlos Prev' },
      { id: 'a5', kind: 'lease', status: 'active', unitId: 'u2', start: '2026-07-16', end: '2026-08-20', rateCents: 190000, residentName: 'Diana Next' },
      { id: 'a6', kind: 'nightly', status: 'active', unitId: 'u5', start: '2026-07-08', end: '2026-07-15', rateCents: 45000, residentName: 'Bob Beach' },
    ],
    invoices: [
      { id: 'i1', agreementId: 'a1', issuedAt: '2026-05-20T00:00:00Z', dueAt: '2026-05-27T00:00:00Z', totalCents: 50000, paidCents: 0, status: 'open' },
      { id: 'i2', agreementId: 'a1', issuedAt: '2026-07-05T00:00:00Z', dueAt: '2026-07-20T00:00:00Z', totalCents: 20000, paidCents: 0, status: 'open' },
      { id: 'i3', agreementId: 'a6', issuedAt: '2026-07-08T00:00:00Z', dueAt: '2026-07-09T00:00:00Z', totalCents: 90000, paidCents: 90000, status: 'paid' },
    ],
    payments: [{ id: 'p1', invoiceId: 'i3', amountCents: 90000, receivedAt: '2026-07-08T00:00:00Z', status: 'recorded' }],
    deposits: [{ id: 'd1', agreementId: 'a1', amountCents: 100000, status: 'held', heldAt: '2026-04-02T00:00:00Z' }],
    bills: [], apPayments: [],
    leads: [
      { id: 'L1', stage: 'toured', estValueCents: 100000, createdAt: '2026-06-20T00:00:00Z', updatedAt: '2026-06-25T00:00:00Z' },
      { id: 'L2', stage: 'signed', estValueCents: 200000, createdAt: '2026-05-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z' },
      { id: 'L3', stage: 'lost', estValueCents: 300000, createdAt: '2026-05-01T00:00:00Z', updatedAt: '2026-05-20T00:00:00Z' },
    ],
    workOrders: [
      { id: 'w1', status: 'open', priority: 'urgent', openedAt: '2026-07-01T00:00:00Z', title: 'AC broken' },
      { id: 'w2', status: 'completed', priority: 'normal', openedAt: '2026-06-01T00:00:00Z', title: 'Done thing' },
    ],
    holds: [], ledgerBalanced: true,
  };
}

test('the catalog carries the PMS staples', () => {
  const keys = REPORT_CATALOG.map((r) => r.key);
  for (const k of ['rent_roll', 'delinquency', 'lease_expirations', 'box_score', 'vacancy', 'wo_aging']) {
    assert.ok(keys.includes(k), `catalog missing ${k}`);
  }
});

test('rent roll: one row per unit with status, resident, rate, deposit and balance', () => {
  const rep = buildReport('rent_roll', world())!;
  assert.equal(rep.rows.length, 5);
  const u1 = rep.rows.find((r) => r['unit'] === 'Apt 101')!;
  assert.equal(u1['status'], 'occupied');
  assert.equal(u1['resident'], 'Alice Souza');
  assert.equal(u1['rent'], 200000);
  assert.equal(u1['deposit'], 100000);
  assert.equal(u1['balance'], 70000); // 50000 overdue + 20000 current
  assert.equal(rep.rows.find((r) => r['unit'] === 'Apt 102')!['status'], 'vacant');
  assert.equal(rep.rows.find((r) => r['unit'] === 'Apt 103')!['status'], 'vacant');
  assert.equal(rep.rows.find((r) => r['unit'] === 'Apt 104 (reforma)')!['status'], 'offline');
  assert.equal(rep.rows.find((r) => r['unit'] === 'Casa Praia')!['resident'], 'Bob Beach');
});

test('rent roll KPIs: occupancy over rentable units + money totals', () => {
  const rep = buildReport('rent_roll', world())!;
  const k = Object.fromEntries(rep.kpis.map((x) => [x.label, x.value]));
  assert.equal(k['Occupancy'], 50); // 2 occupied / 4 rentable
  assert.equal(k['Scheduled rent'], 245000); // 200000 + 45000
  assert.equal(k['Outstanding balances'], 70000);
  assert.equal(k['Deposits held'], 100000);
});

test('delinquency buckets the overdue amount by age and keeps current separate', () => {
  const rep = buildReport('delinquency', world())!;
  assert.equal(rep.rows.length, 1); // only Alice owes; Bob is paid in full
  const r = rep.rows[0]!;
  assert.equal(r['resident'], 'Alice Souza');
  assert.equal(r['unit'], 'Apt 101');
  assert.equal(r['current'], 20000);
  assert.equal(r['d31_60'], 50000); // due 45 days ago
  assert.equal(r['total'], 70000);
});

test('delinquency KPIs separate past-due from total receivable', () => {
  const rep = buildReport('delinquency', world())!;
  const k = Object.fromEntries(rep.kpis.map((x) => [x.label, x.value]));
  assert.equal(k['Past due'], 50000);
  assert.equal(k['Total receivable'], 70000);
  assert.equal(k['90+ days'], 0);
  assert.equal(k['Accounts with balance'], 1);
});

test('lease expirations bucket active agreements by end month, chronologically', () => {
  const rep = buildReport('lease_expirations', world())!;
  const months = rep.rows.map((r) => r['month']);
  assert.deepEqual(months, ['2026-07', '2026-08', '2027-03']); // a6, a5, a1
  const m0803 = rep.rows.find((r) => r['month'] === '2027-03')!;
  assert.equal(m0803['rentAtRisk'], 200000);
});

test('lease expiration KPIs: cumulative 30/60/90-day exposure', () => {
  const rep = buildReport('lease_expirations', world())!;
  const k = Object.fromEntries(rep.kpis.map((x) => [x.label, x.value]));
  assert.equal(k['Expiring ≤30d'], 1); // a6 ends 07-15
  assert.equal(k['Expiring ≤60d'], 2); // + a5 ends 08-20
  assert.equal(k['Expiring ≤90d'], 2);
});

test('box score counts window move-ins/outs and funnel activity', () => {
  const rep = buildReport('box_score', world())!;
  const row = (m: string) => rep.rows.find((r) => r['metric'] === m)!['value'];
  assert.equal(row('Move-ins (agreement starts)'), 1); // a6 started 07-08
  assert.equal(row('Move-outs (agreement ends)'), 1); // a2 ended 07-01
  assert.equal(row('Leases signed'), 1); // L2 updated in window
  assert.equal(row('Leads lost'), 0); // L3 updated before the window
  assert.equal(row('New leads'), 1); // L1
});

test('vacancy lists vacant units with days vacant, never-occupied, and rent at risk', () => {
  const rep = buildReport('vacancy', world())!;
  assert.equal(rep.rows.length, 2); // u2 + u3; offline u4 excluded
  const u2 = rep.rows.find((r) => r['unit'] === 'Apt 102')!;
  assert.equal(u2['daysVacant'], 10); // since 2026-07-01
  assert.equal(u2['rentAtRisk'], 190000); // the signed future lease's rate
  const u3 = rep.rows.find((r) => r['unit'] === 'Apt 103')!;
  assert.equal(u3['lastOccupied'], 'never occupied');
  const k = Object.fromEntries(rep.kpis.map((x) => [x.label, x.value]));
  assert.equal(k['Vacancy'], 50); // 2 of 4 rentable
});

test('work-order aging shows only open orders with days open', () => {
  const rep = buildReport('wo_aging', world())!;
  assert.equal(rep.rows.length, 1);
  assert.equal(rep.rows[0]!['workOrder'], 'AC broken');
  assert.equal(rep.rows[0]!['daysOpen'], 10);
  const k = Object.fromEntries(rep.kpis.map((x) => [x.label, x.value]));
  assert.equal(k['High/urgent'], 1);
});

test('endpoint: rent roll + delinquency over the seeded demo tenant name real residents', () => {
  const mgr: AuthContext = { actor: 'm', tenantId: 'jq', role: 'manager' };
  const app = new App({ authenticator: new StaticTokenAuthenticator({ mgr }), now: () => NOW });
  app.dispatch({ method: 'POST', path: '/demo/seed', bearer: 'Bearer mgr', body: {} });
  const rr = app.dispatch({ method: 'GET', path: '/reports/rent_roll', bearer: 'Bearer mgr', body: {} });
  assert.equal(rr.status, 200);
  const rows = (rr.body as { report: { rows: Array<Record<string, unknown>> } }).report.rows;
  assert.equal(rows.length, 9); // every seeded unit appears
  // Party-linked resident resolves by display name…
  assert.ok(rows.some((r) => r['resident'] === 'Maria Fernanda Costa'));
  // …and an agreement with NO party link falls back to the master-data guest.
  assert.ok(rows.some((r) => r['resident'] === 'Beatriz Oliveira'));
  const dq = app.dispatch({ method: 'GET', path: '/reports/delinquency', bearer: 'Bearer mgr', body: {} });
  assert.equal(dq.status, 200);
  const dqRows = (dq.body as { report: { rows: Array<Record<string, unknown>> } }).report.rows;
  assert.ok(dqRows.length >= 2, `expected seeded delinquents, got ${dqRows.length}`); // overdue June rent + student
});
