// Tranche 59 — Phase 0 defect sweep. Five defects surfaced by the enterprise
// due-diligence audit: (1) the accountant role could not read reports / issue
// invoices / run collections; (2) a human could approve their own escalation
// (segregation-of-duties hole); (3) lead source was stored but not reportable;
// (4) the agreement summary hid lease-executed status and the rent roll blanked
// residents with no party link; (5) a nightly pricing rule masked a floorplan's
// monthly market rent on the public site. 8 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';
import { BUILTIN_ROLES } from '../src/rbac.ts';

const NOW = '2026-07-13T00:00:00Z';
const owner: AuthContext = { actor: 'own', tenantId: 't', role: 'owner' };
const acct: AuthContext = { actor: 'acc', tenantId: 't', role: 'accountant' };
const mgr: AuthContext = { actor: 'mgr', tenantId: 't', role: 'manager' };
const boss: AuthContext = { actor: 'boss', tenantId: 't', role: 'manager' };

function mkApp() {
  return new App({
    authenticator: new StaticTokenAuthenticator({ own: owner, acc: acct, mgr, boss }),
    units: [{ id: 'u-1', tenantId: 't' }],
    now: () => NOW,
  });
}
const D = (app: App, method: string, path: string, token: string | null, body?: Record<string, unknown>) =>
  app.dispatch({ method, path, ...(token ? { bearer: `Bearer ${token}` } : {}), body: body ?? {} });

// --- Defect 1: accountant role permissions -------------------------------
test('the built-in accountant role now grants reports.read, invoice.issue, collections.run', () => {
  const role = BUILTIN_ROLES.find((r) => r.id === 'accountant')!;
  const perms = role.permissions as readonly string[];
  for (const p of ['reports.read', 'invoice.issue', 'collections.run', 'bill.pay', 'ledger.read']) {
    assert.ok(perms.includes(p), `accountant should have ${p}`);
  }
});

test('an accountant can pull reports and run the collections sweep (was 403)', () => {
  const app = mkApp();
  assert.equal(D(app, 'GET', '/reports/catalog', 'acc').status, 200);
  assert.equal(D(app, 'GET', '/reports/rent_roll', 'acc').status, 200);
  assert.equal(D(app, 'POST', '/collections/sweep', 'acc').status, 200);
});

// --- Defect 2: segregation of duties on approvals ------------------------
function escalateBillPay(app: App): string {
  D(app, 'POST', '/parties', 'mgr', { id: 'p-v', kind: 'organization', displayName: 'Vendor' });
  D(app, 'POST', '/bills', 'mgr', { id: 'b-big', payeeId: 'p-v', dueAt: '2026-07-20', lines: [{ description: 'roof', account: 'expenses:maintenance', amountCents: 600000 }] });
  const r = D(app, 'POST', '/bills/b-big/pay', 'mgr', { id: 'pay-big', amountCents: 600000, method: 'transfer' });
  assert.equal(r.status, 202);
  return (r.body as { exceptionId: string }).exceptionId;
}

test('the initiator of an escalation CANNOT approve it (403)', () => {
  const app = mkApp();
  const excId = escalateBillPay(app);
  const r = D(app, 'POST', `/exceptions/${excId}/approve`, 'mgr', {}); // mgr initiated it
  assert.equal(r.status, 403);
  // The bill is still open — nothing self-approved.
  const bill = (D(app, 'GET', '/bills', 'mgr').body as { bills: Array<{ id: string; status: string }> }).bills.find((b) => b.id === 'b-big');
  assert.equal(bill!.status, 'open');
});

test('a DIFFERENT authorized approver can approve it (200, payment executes)', () => {
  const app = mkApp();
  const excId = escalateBillPay(app);
  const r = D(app, 'POST', `/exceptions/${excId}/approve`, 'boss', {}); // different manager
  assert.equal(r.status, 200);
  assert.equal((r.body as { executed: boolean }).executed, true);
  const bill = (D(app, 'GET', '/bills', 'mgr').body as { bills: Array<{ id: string; status: string }> }).bills.find((b) => b.id === 'b-big');
  assert.equal(bill!.status, 'paid');
});

// --- Defect 3: lead source is reportable ---------------------------------
test('the report builder can group leads by acquisition source', () => {
  const app = mkApp();
  D(app, 'POST', '/leads', 'mgr', { id: 'l-1', name: 'A', source: 'zillow', estValueCents: 100000 });
  D(app, 'POST', '/leads', 'mgr', { id: 'l-2', name: 'B', source: 'zillow', estValueCents: 100000 });
  D(app, 'POST', '/leads', 'mgr', { id: 'l-3', name: 'C', source: 'referral', estValueCents: 100000 });
  D(app, 'POST', '/leads', 'mgr', { id: 'l-4', name: 'D', estValueCents: 100000 }); // no source
  const sources = (D(app, 'GET', '/reports/build/sources', 'mgr').body as { sources: Array<{ key: string; dimensions: Array<{ key: string }> }> }).sources;
  const leadDims = sources.find((s) => s.key === 'leads')!.dimensions.map((d) => d.key);
  assert.ok(leadDims.includes('source'), 'leads source dimension exposed');
  const built = D(app, 'POST', '/reports/build', 'mgr', { source: 'leads', dimension: 'source', measure: 'count' });
  assert.equal(built.status, 200);
  const rows = (built.body as { report: { rows: Array<{ label: string; value: number }> } }).report.rows;
  const byKey = Object.fromEntries(rows.map((r) => [r.label, r.value]));
  assert.equal(byKey['zillow'], 2);
  assert.equal(byKey['referral'], 1);
  assert.equal(byKey['unattributed'], 1); // blank source folded
});

// --- Defect 4: leaseExecuted on summary + rent-roll resident fallback ----
test('the agreement summary exposes leaseExecuted without scanning history', () => {
  const app = mkApp();
  D(app, 'POST', '/agreements', 'mgr', { id: 'ag-1', guestId: 'g-ext', unitId: 'u-1', kind: 'nightly', start: '2026-07-01', end: '2026-07-10', rateCents: 20000 });
  const summary = D(app, 'GET', '/agreements/ag-1', 'mgr').body as { leaseExecuted?: boolean };
  assert.equal(summary.leaseExecuted, false);
});

test('the rent roll falls back to the guestId when no party/master-data name resolves', () => {
  const app = mkApp();
  // Booked via API with a guestId that is NOT a master-data guest and has no party link.
  D(app, 'POST', '/agreements', 'mgr', { id: 'ag-1', guestId: 'g-ext-77', unitId: 'u-1', kind: 'monthly', start: '2026-07-01', end: '2027-07-01', rateCents: 300000 });
  D(app, 'POST', '/agreements/ag-1/activate', 'mgr', {});
  const rep = (D(app, 'GET', '/reports/rent_roll', 'mgr').body as { report: { rows: Array<{ resident: string; status: string }> } }).report;
  const occupied = rep.rows.find((r) => r.status === 'occupied')!;
  assert.equal(occupied.resident, 'g-ext-77'); // identifier shown, not a blank "—"
});

// --- Defect 5: floorplan market rent beats a nightly pricing-rule base ----
test('a floorplan market rent takes precedence over a generic pricing-rule base on the site', () => {
  const app = mkApp();
  D(app, 'PUT', '/config', 'own', { displayName: 'Greyline', country: 'US' });
  // A cheap generic nightly rule (base $245) that used to mask monthly rents.
  D(app, 'POST', '/pricing-rules', 'mgr', { id: 'pr-1', name: 'std', baseCents: 24500 });
  D(app, 'POST', '/unit-types', 'mgr', { code: '1BR', name: 'One bedroom', baseRentCents: 245000 });
  D(app, 'POST', '/units', 'mgr', { id: 'unit-a1', code: 'A1', label: 'Apt A1', typeId: 'utype-1br' });
  const site = D(app, 'GET', '/site/t/config', null).body as { units: Array<{ id: string; fromCents: number | null }>; floorplans: Array<{ fromCents: number | null }> };
  assert.equal(site.units.find((u) => u.id === 'unit-a1')!.fromCents, 245000); // market rent, not 24500
  assert.equal(site.floorplans[0]!.fromCents, 245000);
});
