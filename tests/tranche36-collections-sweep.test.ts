// Tranche 36 — collections sweep wiring (#8). The overdue ladder + late-fee math
// existed but nothing ran the sweep. POST /collections/sweep finds each open,
// past-due invoice's highest stage and dispatches its policy action (remind/
// late_fee execute; suspend/evict escalate), idempotently. 8 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';
import { ACCOUNTS } from '../src/billing.ts';

const bearer = (t: string) => `Bearer ${t}`;
const D = (app: App, method: string, path: string, token: string, body?: Record<string, unknown>) =>
  app.dispatch({ method, path, bearer: bearer(token), body });

function makeApp(now = '2026-07-01T00:00:00Z') {
  const mgr: AuthContext = { actor: 'mgr', tenantId: 't1', role: 'manager' };
  const desk: AuthContext = { actor: 'desk', tenantId: 't1', role: 'front_desk' };
  const auth = new StaticTokenAuthenticator({ mgr, desk });
  return new App({ authenticator: auth, units: [{ id: 'u-1', tenantId: 't1' }], now: () => now });
}

// An active agreement with an unpaid invoice due on `dueAt`.
function overdueInvoice(app: App, id = 'inv-1', dueAt = '2026-06-01', amountCents = 100000) {
  D(app, 'POST', '/agreements', 'mgr', { id: `ag-${id}`, guestId: 'g-1', unitId: 'u-1', kind: 'monthly', start: '2026-05-01', end: '2026-12-01', rateCents: amountCents });
  D(app, 'POST', `/agreements/ag-${id}/activate`, 'mgr', {});
  D(app, 'POST', '/invoices', 'mgr', { id, agreementId: `ag-${id}`, dueAt, lines: [{ description: 'rent', account: ACCOUNTS.roomRevenue, amountCents }] });
}

test('sweep on a not-yet-due invoice does nothing', () => {
  const app = makeApp('2026-06-05T00:00:00Z');
  overdueInvoice(app, 'inv-1', '2026-07-01'); // due in the future
  const r = D(app, 'POST', '/collections/sweep', 'mgr', {});
  assert.equal(r.status, 200);
  assert.equal((r.body as { swept: number; actions: unknown[] }).actions.length, 0);
});

test('a 12-day-overdue invoice reaches the late_fee stage and posts a receivable ONCE', () => {
  const app = makeApp('2026-06-13T00:00:00Z'); // 12 days past a 2026-06-01 due date
  overdueInvoice(app, 'inv-1', '2026-06-01', 100000);
  const r = D(app, 'POST', '/collections/sweep', 'mgr', {}).body as { actions: Array<{ stage: string; action: string; outcome: string }> };
  const act = r.actions.find((a) => a.action === 'late_fee');
  assert.ok(act, 'late_fee stage applied');
  assert.equal(act!.outcome, 'executed');
  // a late-fee invoice was posted (2% of 100000 = 2000)
  const latefee = D(app, 'GET', '/invoices/latefee-inv-1', 'mgr');
  assert.equal(latefee.status, 200);
  assert.equal((latefee.body as { totalCents: number }).totalCents, 2000);
});

test('re-running the sweep is idempotent — no second late fee, stage marked already_applied', () => {
  const app = makeApp('2026-06-13T00:00:00Z');
  overdueInvoice(app, 'inv-1', '2026-06-01', 100000);
  D(app, 'POST', '/collections/sweep', 'mgr', {});
  const again = D(app, 'POST', '/collections/sweep', 'mgr', {}).body as { actions: Array<{ outcome: string }> };
  assert.ok(again.actions.every((a) => a.outcome === 'already_applied'));
  // still exactly one late-fee invoice
  const inv = D(app, 'GET', '/invoices/latefee-inv-1', 'mgr').body as { totalCents: number };
  assert.equal(inv.totalCents, 2000);
});

test('a 1-week-overdue invoice only reminds (no fee yet)', () => {
  const app = makeApp('2026-06-08T00:00:00Z'); // 7 days overdue
  overdueInvoice(app, 'inv-1', '2026-06-01');
  const r = D(app, 'POST', '/collections/sweep', 'mgr', {}).body as { actions: Array<{ action: string; outcome: string }> };
  assert.equal(r.actions[0]!.action, 'remind');
  assert.equal(r.actions[0]!.outcome, 'executed');
  assert.equal(D(app, 'GET', '/invoices/latefee-inv-1', 'mgr').status, 404); // no fee posted
});

test('a 25-day-overdue invoice ESCALATES (suspend) — parked, not executed', () => {
  const app = makeApp('2026-06-26T00:00:00Z'); // 25 days overdue → suspend stage
  overdueInvoice(app, 'inv-1', '2026-06-01');
  const r = D(app, 'POST', '/collections/sweep', 'mgr', {}).body as { actions: Array<{ action: string; outcome: string; exceptionId?: string }> };
  const act = r.actions[0]!;
  assert.equal(act.action, 'suspend');
  assert.equal(act.outcome, 'escalated');
  assert.ok(act.exceptionId);
});

test('an escalated stage is not re-escalated on the next sweep (no duplicate exceptions)', () => {
  const app = makeApp('2026-06-26T00:00:00Z');
  overdueInvoice(app, 'inv-1', '2026-06-01');
  D(app, 'POST', '/collections/sweep', 'mgr', {});
  const before = (D(app, 'GET', '/exceptions', 'mgr').body as { pending: unknown[] }).pending.length;
  D(app, 'POST', '/collections/sweep', 'mgr', {}); // again
  const after = (D(app, 'GET', '/exceptions', 'mgr').body as { pending: unknown[] }).pending.length;
  assert.equal(after, before); // no new exception
});

test('a paid invoice is not swept', () => {
  const app = makeApp('2026-06-20T00:00:00Z');
  overdueInvoice(app, 'inv-1', '2026-06-01', 100000);
  D(app, 'POST', '/payments', 'mgr', { id: 'pay-1', invoiceId: 'inv-1', amountCents: 100000, method: 'card' });
  const r = D(app, 'POST', '/collections/sweep', 'mgr', {}).body as { swept: number };
  assert.equal(r.swept, 0);
});

test('RBAC: front desk cannot run the sweep (needs collections.run)', () => {
  const app = makeApp('2026-06-20T00:00:00Z');
  overdueInvoice(app, 'inv-1', '2026-06-01');
  assert.equal(D(app, 'POST', '/collections/sweep', 'desk', {}).status, 403);
});
