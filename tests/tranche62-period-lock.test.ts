// Tranche 62 — Phase 1C: period close / posting locks. Once an accounting
// period is closed, no journal entry may post into it (a fund's numbers can't
// silently change); closing is routine, re-opening is a policy-gated
// restatement. Enforcement at the ledger, the endpoints, RBAC, the escalation,
// and the snapshot→rehydrate round trip. 9 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';

const NOW = '2026-07-13T00:00:00Z';
const own: AuthContext = { actor: 'own', tenantId: 'mf', role: 'owner' };
const boss: AuthContext = { actor: 'boss', tenantId: 'mf', role: 'manager' };
const acct: AuthContext = { actor: 'acc', tenantId: 'mf', role: 'accountant' };
const desk: AuthContext = { actor: 'fd', tenantId: 'mf', role: 'front_desk' };

function mkApp() {
  return new App({ authenticator: new StaticTokenAuthenticator({ own, boss, acc: acct, fd: desk }), units: [], now: () => NOW });
}
const D = (app: App, method: string, path: string, body?: Record<string, unknown>, token = 'own') =>
  app.dispatch({ method, path, bearer: `Bearer ${token}`, body: body ?? {} });

function seed(app: App) {
  D(app, 'PUT', '/config', { displayName: 'Greyline', country: 'US' });
  D(app, 'POST', '/units', { id: 'u-1', code: 'A-1', label: 'A1' });
  D(app, 'POST', '/agreements', { id: 'ag-1', guestId: 'g-1', unitId: 'u-1', kind: 'monthly', start: '2026-06-01', end: '2027-06-01', rateCents: 300000 });
  D(app, 'POST', '/agreements/ag-1/activate', {});
}
const issueInvoice = (app: App, id: string, issuedAt: string, token = 'own') =>
  D(app, 'POST', '/invoices', { id, agreementId: 'ag-1', issuedAt, dueAt: '2026-08-10', lines: [{ description: 'rent', account: 'revenue:room', amountCents: 300000 }] }, token);

test('closing a period lists it as closed', () => {
  const app = mkApp(); seed(app);
  const r = D(app, 'POST', '/periods/close', { period: '2026-06' });
  assert.equal(r.status, 200);
  assert.equal((r.body as { status: string }).status, 'closed');
  const list = (D(app, 'GET', '/periods').body as { periods: Array<{ period: string; status: string }> }).periods;
  assert.deepEqual(list, [{ tenantId: 'mf', period: '2026-06', status: 'closed', closedAt: NOW, closedBy: 'own' }]);
});

test('an invoice cannot post into a closed month (409), an open month is fine', () => {
  const app = mkApp(); seed(app);
  D(app, 'POST', '/periods/close', { period: '2026-06' });
  const blocked = issueInvoice(app, 'inv-jun', '2026-06-15T00:00:00Z');
  assert.equal(blocked.status, 409);
  assert.match((blocked.body as { error: string }).error, /2026-06 is closed/);
  const ok = issueInvoice(app, 'inv-jul', '2026-07-15T00:00:00Z');
  assert.equal(ok.status, 201);
});

test('a payment cannot post into a closed month either', () => {
  const app = mkApp(); seed(app);
  issueInvoice(app, 'inv-jun', '2026-06-15T00:00:00Z'); // issue while open
  D(app, 'POST', '/periods/close', { period: '2026-06' });
  const pay = D(app, 'POST', '/payments', { id: 'pay-1', invoiceId: 'inv-jun', amountCents: 100000, method: 'transfer', receivedAt: '2026-06-20T00:00:00Z' });
  assert.equal(pay.status, 409);
});

test('re-opening a closed period ESCALATES (202) and does not auto-open', () => {
  const app = mkApp(); seed(app);
  D(app, 'POST', '/periods/close', { period: '2026-06' });
  const r = D(app, 'POST', '/periods/reopen', { period: '2026-06' });
  assert.equal(r.status, 202);
  assert.equal((r.body as { status: string }).status, 'escalated');
  // Still closed — posting still blocked.
  assert.equal(issueInvoice(app, 'inv-x', '2026-06-15T00:00:00Z').status, 409);
});

test('after a human approves the reopen, posting into the month works again', () => {
  const app = mkApp(); seed(app);
  D(app, 'POST', '/periods/close', { period: '2026-06' });
  const esc = D(app, 'POST', '/periods/reopen', { period: '2026-06' });
  const exId = (esc.body as { exceptionId: string }).exceptionId;
  const ap = D(app, 'POST', `/exceptions/${exId}/approve`, {}, 'boss'); // different approver (SoD)
  assert.equal(ap.status, 200);
  assert.equal(issueInvoice(app, 'inv-reopened', '2026-06-15T00:00:00Z').status, 201);
});

test('an accountant can close; a front-desk user cannot', () => {
  const app = mkApp(); seed(app);
  assert.equal(D(app, 'POST', '/periods/close', { period: '2026-05' }, 'acc').status, 200);
  assert.equal(D(app, 'POST', '/periods/close', { period: '2026-04' }, 'fd').status, 403);
});

test('an invalid period string is rejected', () => {
  const app = mkApp(); seed(app);
  assert.ok(D(app, 'POST', '/periods/close', { period: '2026-13' }).status >= 400);
  assert.ok(D(app, 'POST', '/periods/close', { period: 'June' }).status >= 400);
});

test('reopening a period that was never closed errors', () => {
  const app = mkApp(); seed(app);
  const r = D(app, 'POST', '/periods/reopen', { period: '2026-06' });
  // The escalation runs the reopen thunk only on approve; a live escalation
  // parks (202) but here it's never closed so... the guard is inside the thunk.
  // Approve it and confirm the underlying reopen refuses.
  assert.equal(r.status, 202);
  const exId = (r.body as { exceptionId: string }).exceptionId;
  const ap = D(app, 'POST', `/exceptions/${exId}/approve`, {}, 'boss');
  assert.notEqual(ap.status, 200); // period not closed -> reopen throws on approval
});

test('a closed period survives snapshot → rehydrate (posting stays blocked)', () => {
  const app = mkApp(); seed(app);
  D(app, 'POST', '/periods/close', { period: '2026-06' });
  const b = mkApp();
  b.rehydrate(app.snapshotWorld('mf'));
  assert.equal((D(b, 'GET', '/periods').body as { periods: unknown[] }).periods.length, 1);
  // Rebuild the agreement context in b via rehydrate already done; posting a
  // June invoice must still be blocked.
  const blocked = issueInvoice(b, 'inv-after', '2026-06-15T00:00:00Z');
  assert.equal(blocked.status, 409);
});
