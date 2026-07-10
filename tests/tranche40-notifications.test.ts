// Tranche 40 — notification transport. The kernel RECORDS a notification
// (channel + recipient + canonical kind + non-secret data); an edge worker sends
// it later, resolving the provider credential from the secret store. Domain events
// (collections reminder, e-sign send, payment receipt) auto-enqueue. 11 tests.

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
  const ro: AuthContext = { actor: 'aud', tenantId: 't1', role: 'read_only' };
  const svc: AuthContext = { actor: 'wk', tenantId: 't1', role: 'service' };
  const other: AuthContext = { actor: 'sp', tenantId: 't2', role: 'owner' };
  const auth = new StaticTokenAuthenticator({ mgr, ro, svc, sp: other });
  return new App({ authenticator: auth, units: [{ id: 'u-1', tenantId: 't1' }], now: () => now });
}

// ---- direct enqueue + outbox ---------------------------------------------

test('enqueue a notification → pending in the outbox; GET lists it', () => {
  const app = makeApp();
  const r = D(app, 'POST', '/notifications', 'mgr', { id: 'n1', channel: 'email', to: 'ana@x.com', kind: 'general', data: { subject: 'Hi', body: 'Welcome' } });
  assert.equal(r.status, 201);
  assert.equal((r.body as { status: string }).status, 'pending');
  assert.equal((D(app, 'GET', '/notifications', 'mgr').body as { notifications: unknown[] }).notifications.length, 1);
});

test('an unknown kind is rejected (400); an unknown channel is rejected', () => {
  const app = makeApp();
  assert.equal(D(app, 'POST', '/notifications', 'mgr', { id: 'n1', channel: 'email', to: 'a@x.com', kind: 'telepathy' }).status, 400);
  assert.equal(D(app, 'POST', '/notifications', 'mgr', { id: 'n2', channel: 'carrier_pigeon', to: 'a@x.com', kind: 'general' }).status, 409);
});

test('the edge worker reports delivery: markSent sets sent + providerRef', () => {
  const app = makeApp();
  D(app, 'POST', '/notifications', 'mgr', { id: 'n1', channel: 'email', to: 'a@x.com', kind: 'general', data: {} });
  const sent = D(app, 'POST', '/notifications/n1/sent', 'svc', { providerRef: 'sg-123' });
  assert.equal(sent.status, 200);
  const b = sent.body as { status: string; providerRef: string };
  assert.equal(b.status, 'sent');
  assert.equal(b.providerRef, 'sg-123');
});

test('markFailed records the reason', () => {
  const app = makeApp();
  D(app, 'POST', '/notifications', 'mgr', { id: 'n1', channel: 'sms', to: '+5511', kind: 'general', data: {} });
  const f = D(app, 'POST', '/notifications/n1/failed', 'svc', { reason: 'bounced' });
  assert.equal((f.body as { status: string; failedReason: string }).failedReason, 'bounced');
});

test("a callback for another tenant's notification is 404 (no cross-tenant)", () => {
  const app = makeApp();
  D(app, 'POST', '/notifications', 'mgr', { id: 'n1', channel: 'email', to: 'a@x.com', kind: 'general', data: {} });
  assert.equal(D(app, 'POST', '/notifications/n1/sent', 'sp', {}).status, 404);
});

test('RBAC: read_only cannot send; can read', () => {
  const app = makeApp();
  assert.equal(D(app, 'POST', '/notifications', 'ro', { id: 'n1', channel: 'email', to: 'a@x.com', kind: 'general' }).status, 403);
  assert.equal(D(app, 'GET', '/notifications', 'ro').status, 200);
});

// ---- domain triggers -----------------------------------------------------

// An active agreement whose bill-to party has an email, plus an overdue invoice.
function agreementWithResident(app: App, agId = 'ag-1', invId = 'inv-1', email = 'ana@x.com') {
  D(app, 'POST', '/agreements', 'mgr', { id: agId, guestId: 'g-1', unitId: 'u-1', kind: 'monthly', start: '2026-05-01', end: '2026-12-01', rateCents: 100000 });
  D(app, 'POST', `/agreements/${agId}/activate`, 'mgr', {});
  D(app, 'POST', '/parties', 'mgr', { id: `p-${agId}`, kind: 'person', displayName: 'Ana', email });
  D(app, 'POST', `/agreements/${agId}/parties`, 'mgr', { partyId: `p-${agId}`, role: 'resident' });
  D(app, 'POST', '/invoices', 'mgr', { id: invId, agreementId: agId, dueAt: '2026-06-01', lines: [{ description: 'rent', account: ACCOUNTS.roomRevenue, amountCents: 100000 }] });
}

test('the collections sweep enqueues a reminder email to the resident', () => {
  const app = makeApp('2026-06-13T00:00:00Z'); // late_fee stage
  agreementWithResident(app);
  D(app, 'POST', '/collections/sweep', 'mgr', {});
  const notifs = (D(app, 'GET', '/notifications', 'mgr').body as { notifications: Array<{ kind: string; to: string; channel: string }> }).notifications;
  const rem = notifs.find((n) => n.kind === 'collections_reminder');
  assert.ok(rem, 'a reminder was enqueued');
  assert.equal(rem!.to, 'ana@x.com');
  assert.equal(rem!.channel, 'email');
});

test('e-sign send emails every signer a request', () => {
  const app = makeApp();
  D(app, 'POST', '/signature-envelopes', 'mgr', { id: 'env-1', documentName: 'Lease', provider: 'docusign', signers: [{ name: 'Ana', email: 'ana@x.com', role: 'resident' }, { name: 'Pat', email: 'pat@x.com', role: 'guarantor' }] });
  D(app, 'POST', '/signature-envelopes/env-1/send', 'mgr', { providerRef: 'ext-1' });
  const notifs = (D(app, 'GET', '/notifications', 'mgr').body as { notifications: Array<{ kind: string; to: string }> }).notifications.filter((n) => n.kind === 'esign_request');
  assert.deepEqual(notifs.map((n) => n.to).sort(), ['ana@x.com', 'pat@x.com']);
});

test('recording a payment enqueues a receipt to the payer', () => {
  const app = makeApp('2026-06-20T00:00:00Z');
  agreementWithResident(app);
  D(app, 'POST', '/payments', 'mgr', { id: 'pay-1', invoiceId: 'inv-1', amountCents: 100000, method: 'card' });
  const receipt = (D(app, 'GET', '/notifications', 'mgr').body as { notifications: Array<{ kind: string; to: string }> }).notifications.find((n) => n.kind === 'payment_receipt');
  assert.ok(receipt);
  assert.equal(receipt!.to, 'ana@x.com');
});

test('an agreement with no resident email → no notification (best-effort, never breaks the write)', () => {
  const app = makeApp('2026-06-20T00:00:00Z');
  // Book + invoice + pay, but NO party/email assigned.
  D(app, 'POST', '/agreements', 'mgr', { id: 'ag-1', guestId: 'g-1', unitId: 'u-1', kind: 'monthly', start: '2026-05-01', end: '2026-12-01', rateCents: 100000 });
  D(app, 'POST', '/agreements/ag-1/activate', 'mgr', {});
  D(app, 'POST', '/invoices', 'mgr', { id: 'inv-1', agreementId: 'ag-1', dueAt: '2026-06-01', lines: [{ description: 'rent', account: ACCOUNTS.roomRevenue, amountCents: 100000 }] });
  const pay = D(app, 'POST', '/payments', 'mgr', { id: 'pay-1', invoiceId: 'inv-1', amountCents: 100000, method: 'card' });
  assert.equal(pay.status, 201); // the payment still succeeds
  assert.equal((D(app, 'GET', '/notifications', 'mgr').body as { notifications: unknown[] }).notifications.length, 0);
});

test('notifications survive snapshot → rehydrate', () => {
  const app = makeApp();
  D(app, 'POST', '/notifications', 'mgr', { id: 'n1', channel: 'email', to: 'a@x.com', kind: 'general', data: { subject: 's', body: 'b' } });
  const snap = app.snapshotWorld('t1');
  const b = new App({ authenticator: new StaticTokenAuthenticator({ mgr: { actor: 'm', tenantId: 't1', role: 'manager' } }), now: () => 'T' });
  b.rehydrate(snap);
  assert.equal((b.dispatch({ method: 'GET', path: '/notifications', bearer: bearer('mgr') }).body as { notifications: unknown[] }).notifications.length, 1);
});
