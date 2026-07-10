// Tranche 31 — security hardening (findings from the security review):
//   1. connector.dispatch money-out escalation (bank/payment_gateway payout)
//   2. deposit.refund large-refund escalation (no unbounded money-out)
//   3. action_log is tenant-scoped in the snapshot (no cross-tenant audit bleed)
//   4. secret-key rejection: camelCase, nested, and command payloads
// 7 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';

const T = '2026-07-01T00:00:00Z';
const bearer = (t: string) => `Bearer ${t}`;
const D = (app: App, method: string, path: string, token: string, body?: Record<string, unknown>) =>
  app.dispatch({ method, path, bearer: bearer(token), body });

function makeApp() {
  const owner: AuthContext = { actor: 'ana', tenantId: 't1', role: 'owner' };
  const other: AuthContext = { actor: 'bob', tenantId: 't2', role: 'owner' };
  const auth = new StaticTokenAuthenticator({ own: owner, sp: other });
  return new App({
    authenticator: auth,
    units: [{ id: 'u-1', tenantId: 't1' }, { id: 'u-2', tenantId: 't2' }],
    now: () => T,
  });
}

function agreementWithDeposit(app: App, token: string, tid: string, unitId: string, agId: string, depId: string, depCents: number) {
  D(app, 'POST', '/agreements', token, { id: agId, guestId: `g-${agId}`, unitId, kind: 'nightly', start: '2026-07-01', end: '2026-07-10', rateCents: 20000 });
  D(app, 'POST', `/agreements/${agId}/activate`, token, {});
  return D(app, 'POST', '/deposits', token, { id: depId, agreementId: agId, amountCents: depCents });
}

// --- 1. connector.dispatch money-out escalation -----------------------------

test('a large bank-integration payout command ESCALATES (closes the parallel money-out rail)', () => {
  const app = makeApp();
  D(app, 'POST', '/integrations', 'own', { id: 'int-bank', kind: 'bank', provider: 'itau', config: { endpoint: 'https://api.itau' }, secretRef: 'itau-key' });
  // > R$5,000 payout over the bank rail → human approval (202), same control as bill.pay.
  const big = D(app, 'POST', '/integrations/int-bank/commands', 'own', { id: 'cmd-big', action: 'bank.payout', payload: { amountCents: 600000, to: 'acc-9' } });
  assert.equal(big.status, 202);
  assert.equal((big.body as { status: string }).status, 'escalated');
});

test('a small bank payout and any non-money command still auto-allow', () => {
  const app = makeApp();
  D(app, 'POST', '/integrations', 'own', { id: 'int-bank', kind: 'bank', provider: 'itau', config: {}, secretRef: 'k' });
  D(app, 'POST', '/integrations', 'own', { id: 'int-lock', kind: 'lock', provider: 'salto', config: {}, secretRef: 'k2' });
  assert.equal(D(app, 'POST', '/integrations/int-bank/commands', 'own', { id: 'c-small', action: 'bank.payout', payload: { amountCents: 1000 } }).status, 201);
  // a lock unlock carrying a large "amountCents" is NOT a money rail → allow
  assert.equal(D(app, 'POST', '/integrations/int-lock/commands', 'own', { id: 'c-unlock', action: 'lock.unlock', payload: { amountCents: 9_000_000 } }).status, 201);
});

// --- 2. deposit.refund large-refund escalation ------------------------------

test('refunding more than R$5,000 of a deposit ESCALATES', () => {
  const app = makeApp();
  assert.equal(agreementWithDeposit(app, 'own', 't1', 'u-1', 'ag-1', 'dep-1', 600000).status, 201);
  const refund = D(app, 'POST', '/deposits/dep-1/refund', 'own', {});
  assert.equal(refund.status, 202);
  assert.equal((refund.body as { status: string }).status, 'escalated');
});

test('a small net refund (after deductions) still auto-allows', () => {
  const app = makeApp();
  agreementWithDeposit(app, 'own', 't1', 'u-1', 'ag-1', 'dep-1', 600000);
  // Deduct most of it: net refund 100000 (< threshold) → allow.
  const refund = D(app, 'POST', '/deposits/dep-1/refund', 'own', { deductions: [{ reason: 'damage', amountCents: 500000 }] });
  assert.equal(refund.status, 200);
});

// --- 3. action_log tenant isolation -----------------------------------------

test('snapshotWorld carries ONLY the calling tenant’s action-log entries', () => {
  const app = makeApp();
  // t1 and t2 each perform gated actions.
  D(app, 'POST', '/agreements', 'own', { id: 'ag-1', guestId: 'g1', unitId: 'u-1', kind: 'nightly', start: '2026-07-01', end: '2026-07-10', rateCents: 20000 });
  D(app, 'POST', '/agreements', 'sp', { id: 'ag-2', guestId: 'g2', unitId: 'u-2', kind: 'nightly', start: '2026-07-01', end: '2026-07-10', rateCents: 20000 });
  const w1 = app.snapshotWorld('t1') as unknown as { actionLog: Array<{ tenantId: string }> };
  const w2 = app.snapshotWorld('t2') as unknown as { actionLog: Array<{ tenantId: string }> };
  assert.ok(w1.actionLog.length > 0 && w2.actionLog.length > 0);
  assert.ok(w1.actionLog.every((r) => r.tenantId === 't1'), 't1 snapshot must not contain t2 audit rows');
  assert.ok(w2.actionLog.every((r) => r.tenantId === 't2'), 't2 snapshot must not contain t1 audit rows');
});

// --- 4. secret rejection depth ----------------------------------------------

test('camelCase / nested secret keys in integration config are refused', () => {
  const app = makeApp();
  assert.equal(D(app, 'POST', '/integrations', 'own', { id: 'i1', kind: 'crm', provider: 'sf', config: { accessToken: 'x' } }).status, 409);
  assert.equal(D(app, 'POST', '/integrations', 'own', { id: 'i2', kind: 'bank', provider: 'itau', config: { auth: { clientSecret: 'x' } } }).status, 409);
});

test('a secret inside a connector-command payload is refused', () => {
  const app = makeApp();
  D(app, 'POST', '/integrations', 'own', { id: 'int-lock', kind: 'lock', provider: 'salto', config: {}, secretRef: 'k' });
  assert.equal(D(app, 'POST', '/integrations/int-lock/commands', 'own', { id: 'c-x', action: 'lock.unlock', payload: { apiKey: 'sk-live' } }).status, 409);
});
