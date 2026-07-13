// Tranche 70 — Phase 3A: resident self-service. A party-scoped token (a resident,
// carrying partyId) gets a consolidated home — their lease(s), balance, invoices,
// deposits, renewal offer — and can file a maintenance request against their own
// unit. Strictly party-scoped: a resident sees only their own data. 11 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';

const NOW = '2026-07-13T00:00:00Z';
const own: AuthContext = { actor: 'own', tenantId: 'mf', role: 'owner' };
const resident: AuthContext = { actor: 'bea', tenantId: 'mf', role: 'read_only', partyId: 'pty-bea' };
const other: AuthContext = { actor: 'cid', tenantId: 'mf', role: 'read_only', partyId: 'pty-cid' };

function mkApp() {
  const app = new App({ authenticator: new StaticTokenAuthenticator({ own, bea: resident, cid: other }), units: [], now: () => NOW });
  D(app, 'PUT', '/config', { displayName: 'Greyline', country: 'US' });
  D(app, 'POST', '/units', { id: 'u-1', code: 'A-1', label: 'Apt 101' });
  // A lease expiring within the renewal window, with the resident linked.
  D(app, 'POST', '/agreements', { id: 'ag-1', guestId: 'Bea Lima', unitId: 'u-1', kind: 'lease', start: '2025-09-01', end: '2026-09-01', rateCents: 300000 });
  D(app, 'POST', '/agreements/ag-1/activate', {});
  D(app, 'POST', '/parties', { id: 'pty-bea', kind: 'person', displayName: 'Bea Lima', email: 'bea@x.com' });
  D(app, 'POST', '/agreements/ag-1/parties', { partyId: 'pty-bea', role: 'resident' });
  D(app, 'POST', '/parties', { id: 'pty-cid', kind: 'person', displayName: 'Cid Other', email: 'cid@x.com' });
  // An invoice (open) + a held deposit.
  D(app, 'POST', '/invoices', { id: 'inv-1', agreementId: 'ag-1', issuedAt: NOW, dueAt: '2026-07-20', lines: [{ description: 'rent', account: 'revenue:room', amountCents: 300000 }] });
  D(app, 'POST', '/deposits', { id: 'dep-1', agreementId: 'ag-1', amountCents: 300000 });
  return app;
}
const D = (app: App, method: string, path: string, body?: Record<string, unknown>, token = 'own') =>
  app.dispatch({ method, path, bearer: `Bearer ${token}`, body: body ?? {} });

type Home = { profile: { name: string; email: string }; totalBalanceCents: number; totalDepositCents: number; agreements: Array<{ id: string; role: string; unitLabel: string; balanceCents: number; depositHeldCents: number; daysToExpiry: number }>; renewalOffers: Array<{ agreementId: string; proposedRateCents: number }> };

test('GET /resident/home returns the resident lease, balance and deposit', () => {
  const app = mkApp();
  const home = D(app, 'GET', '/resident/home', undefined, 'bea').body as Home;
  assert.equal(home.profile.name, 'Bea Lima');
  assert.equal(home.agreements.length, 1);
  assert.equal(home.agreements[0]!.id, 'ag-1');
  assert.equal(home.agreements[0]!.unitLabel, 'Apt 101');
  assert.equal(home.agreements[0]!.role, 'resident');
  assert.equal(home.totalBalanceCents, 300000);
  assert.equal(home.totalDepositCents, 300000);
});

test('home surfaces a renewal offer on a lease approaching expiry', () => {
  const app = mkApp();
  const home = D(app, 'GET', '/resident/home', undefined, 'bea').body as Home;
  assert.equal(home.renewalOffers.length, 1);
  assert.equal(home.renewalOffers[0]!.proposedRateCents, 315000); // +5%
});

test('the balance drops as payment lands', () => {
  const app = mkApp();
  D(app, 'POST', '/payments', { id: 'pay-1', invoiceId: 'inv-1', amountCents: 100000, method: 'transfer' });
  assert.equal((D(app, 'GET', '/resident/home', undefined, 'bea').body as Home).totalBalanceCents, 200000);
});

test('an operator token (no partyId) has no resident home', () => {
  const app = mkApp();
  assert.equal(D(app, 'GET', '/resident/home', undefined, 'own').status, 403);
});

test('a resident with no linked lease sees an empty home', () => {
  const app = mkApp();
  const home = D(app, 'GET', '/resident/home', undefined, 'cid').body as Home;
  assert.equal(home.agreements.length, 0);
  assert.equal(home.totalBalanceCents, 0);
});

test('a resident files a maintenance request against their own lease', () => {
  const app = mkApp();
  const r = D(app, 'POST', '/resident/work-orders', { id: 'wo-1', agreementId: 'ag-1', title: 'Leaky faucet', priority: 'high' }, 'bea');
  assert.equal(r.status, 201);
  const wo = r.body as { requestedByPartyId: string; category: string; description: string; status: string };
  assert.equal(wo.requestedByPartyId, 'pty-bea');
  assert.equal(wo.category, 'resident_request');
  assert.match(wo.description, /Apt 101/);
  assert.equal(wo.status, 'open');
});

test('a resident cannot file against a lease they are not linked to', () => {
  const app = mkApp();
  assert.equal(D(app, 'POST', '/resident/work-orders', { id: 'wo-x', agreementId: 'ag-1', title: 'Nope' }, 'cid').status, 404);
});

test('GET /resident/work-orders lists only the resident\'s own requests', () => {
  const app = mkApp();
  D(app, 'POST', '/resident/work-orders', { id: 'wo-1', agreementId: 'ag-1', title: 'Leaky faucet' }, 'bea');
  // An operator-raised WO for another party must not appear in the resident list.
  D(app, 'POST', '/work-orders', { id: 'wo-op', title: 'Lobby light' });
  const list = (D(app, 'GET', '/resident/work-orders', undefined, 'bea').body as { workOrders: Array<{ id: string }> }).workOrders;
  assert.equal(list.length, 1);
  assert.equal(list[0]!.id, 'wo-1');
});

test('the resident maintenance endpoints require a resident session', () => {
  const app = mkApp();
  assert.equal(D(app, 'GET', '/resident/work-orders', undefined, 'own').status, 403);
  assert.equal(D(app, 'POST', '/resident/work-orders', { agreementId: 'ag-1', title: 'x' }, 'own').status, 403);
});

test('a resident cannot reach another tenant\'s data', () => {
  const app = mkApp();
  const outsider: AuthContext = { actor: 'z', tenantId: 'other', role: 'read_only', partyId: 'pty-bea' };
  const app2 = new App({ authenticator: new StaticTokenAuthenticator({ z: outsider }), now: () => NOW });
  app2.dispatch({ method: 'PUT', path: '/config', bearer: 'Bearer z', body: { displayName: 'Other', country: 'US' } });
  // pty-bea does not exist in the 'other' tenant → 404.
  assert.equal(app2.dispatch({ method: 'GET', path: '/resident/home', bearer: 'Bearer z', body: {} }).status, 404);
});

test('the resident maintenance request still passes the work_order.open policy gate', () => {
  const app = mkApp();
  D(app, 'POST', '/resident/work-orders', { id: 'wo-1', agreementId: 'ag-1', title: 'Leaky faucet' }, 'bea');
  const audit = app.snapshotWorld('mf').actionLog.filter((a) => a.action === 'work_order.open');
  assert.ok(audit.length >= 1);
});

// --- Phase 3B: renewal interest + lease document view ---------------------
test('a resident views their own lease document', () => {
  const app = mkApp();
  const r = D(app, 'GET', '/resident/agreements/ag-1/lease-document', undefined, 'bea');
  assert.equal(r.status, 200);
  const doc = (r.body as { document: { title: string; parties: Array<{ role: string; name: string }> } }).document;
  assert.match(doc.title, /Apt 101/);
  assert.ok(doc.parties.some((p) => p.role === 'resident' && p.name === 'Bea Lima'));
});

test('a resident cannot view a lease document for a lease they are not linked to', () => {
  const app = mkApp();
  assert.equal(D(app, 'GET', '/resident/agreements/ag-1/lease-document', undefined, 'cid').status, 404);
  assert.equal(D(app, 'GET', '/resident/agreements/ag-1/lease-document', undefined, 'own').status, 403);
});

test('a resident signals renewal interest; it records to a thread and returns the offer', () => {
  const app = mkApp();
  const r = D(app, 'POST', '/resident/renewal-interest', { agreementId: 'ag-1' }, 'bea');
  assert.equal(r.status, 201);
  const body = r.body as { recorded: boolean; threadId: string; offer: { proposedRateCents: number } };
  assert.equal(body.recorded, true);
  assert.equal(body.offer.proposedRateCents, 315000);
  // The office sees it as a resident thread message (Inbox).
  const msgs = app.dispatch({ method: 'GET', path: '/threads/' + body.threadId, bearer: 'Bearer own', body: {} }).body as { messages: Array<{ authorType: string; body: string }> };
  assert.ok(msgs.messages.some((m) => m.authorType === 'party' && /asked to renew/.test(m.body)));
});

test('renewal interest is idempotent within the same tick and rejects an unlinked lease', () => {
  const app = mkApp();
  D(app, 'POST', '/resident/renewal-interest', { agreementId: 'ag-1' }, 'bea');
  assert.equal(D(app, 'POST', '/resident/renewal-interest', { agreementId: 'ag-1' }, 'bea').status, 201); // no duplicate error
  assert.equal(D(app, 'POST', '/resident/renewal-interest', { agreementId: 'ag-1' }, 'cid').status, 404);
});

// --- Phase 3C: invoice view + payment intent ------------------------------
test('a resident sees their own open invoices with the outstanding amount', () => {
  const app = mkApp();
  const invs = (D(app, 'GET', '/resident/invoices', undefined, 'bea').body as { invoices: Array<{ id: string; outstandingCents: number; status: string }> }).invoices;
  assert.equal(invs.length, 1);
  assert.equal(invs[0]!.id, 'inv-1');
  assert.equal(invs[0]!.outstandingCents, 300000);
});

test('a resident with no lease sees no invoices; operator token is 403', () => {
  const app = mkApp();
  assert.equal((D(app, 'GET', '/resident/invoices', undefined, 'cid').body as { invoices: unknown[] }).invoices.length, 0);
  assert.equal(D(app, 'GET', '/resident/invoices', undefined, 'own').status, 403);
});

test('a payment intent records to a finance thread WITHOUT moving the ledger', () => {
  const app = mkApp();
  const before = app.snapshotWorld('mf').journalLines.length;
  const r = D(app, 'POST', '/resident/payment-intent', { invoiceId: 'inv-1', amountCents: 300000, method: 'pix' }, 'bea');
  assert.equal(r.status, 201);
  assert.equal((r.body as { recorded: boolean }).recorded, true);
  // Nothing settled — the invoice is still open and the ledger is unchanged.
  assert.equal(app.snapshotWorld('mf').journalLines.length, before);
  assert.equal((D(app, 'GET', '/resident/invoices', undefined, 'bea').body as { invoices: Array<{ outstandingCents: number }> }).invoices[0]!.outstandingCents, 300000);
  // The office sees the intent as a finance thread message.
  const thread = app.dispatch({ method: 'GET', path: '/threads/resident-payments-ag-1', bearer: 'Bearer own', body: {} }).body as { messages: Array<{ body: string }> };
  assert.ok(thread.messages.some((m) => /reports a pix payment/.test(m.body)));
});

test('a payment intent for an invoice on an unlinked lease 404s', () => {
  const app = mkApp();
  assert.equal(D(app, 'POST', '/resident/payment-intent', { invoiceId: 'inv-1', amountCents: 1000 }, 'cid').status, 404);
  assert.equal(D(app, 'POST', '/resident/payment-intent', { invoiceId: 'inv-1' }, 'own').status, 403);
});

// --- Phase 3D: documents awaiting signature -------------------------------
test('a resident sees an envelope where they are a signer, with their status', () => {
  const app = mkApp();
  // The office drafts a lease envelope — the resident (with an email) is auto-rostered.
  assert.equal(D(app, 'POST', '/agreements/ag-1/lease-envelope', { id: 'env-1', provider: 'docusign' }).status, 201);
  let mine = (D(app, 'GET', '/resident/envelopes', undefined, 'bea').body as { envelopes: Array<{ id: string; mySignerStatus: string }> }).envelopes;
  assert.equal(mine.length, 1);
  assert.equal(mine[0]!.id, 'env-1');
  assert.equal(mine[0]!.mySignerStatus, 'draft');
  // Once sent, it awaits the resident's signature at the provider.
  D(app, 'POST', '/signature-envelopes/env-1/send', {});
  mine = (D(app, 'GET', '/resident/envelopes', undefined, 'bea').body as { envelopes: Array<{ mySignerStatus: string }> }).envelopes;
  assert.equal(mine[0]!.mySignerStatus, 'awaiting');
});

test('a resident does not see envelopes they are not a signer on', () => {
  const app = mkApp();
  D(app, 'POST', '/agreements/ag-1/lease-envelope', { id: 'env-1', provider: 'docusign' });
  // cid is not a signer on ag-1's lease → sees nothing.
  assert.equal((D(app, 'GET', '/resident/envelopes', undefined, 'cid').body as { envelopes: unknown[] }).envelopes.length, 0);
  assert.equal(D(app, 'GET', '/resident/envelopes', undefined, 'own').status, 403);
});
