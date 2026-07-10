// Tranche 43 — NF-e / NFS-e fiscal document emission seam. Emission is an OUTBOUND
// connector command to the tenant's `fiscal` integration: the kernel enqueues a
// credential-free command (adapter attaches the vendor _request), the edge worker
// performs the real call resolving the certificate from the secret store, and the
// authorization returns via the inbound events port. 13 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';
import { KIND_ACTIONS, KIND_EVENTS, isKnownAction, isKnownEvent, fullContract } from '../src/integration-contract.ts';
import { genericFiscal, defaultAdapterRegistry, AdapterError } from '../src/adapter-registry.ts';
import { planConnectorCommand, DISPATCHABLE_KINDS, MONEY_KINDS } from '../src/connector-adapters.ts';

const bearer = (t: string) => `Bearer ${t}`;
const D = (app: App, method: string, path: string, token: string, body?: Record<string, unknown>) =>
  app.dispatch({ method, path, bearer: bearer(token), body });

function makeApp() {
  const mgr: AuthContext = { actor: 'mgr', tenantId: 't1', role: 'manager' };
  const svc: AuthContext = { actor: 'wk', tenantId: 't1', role: 'service' };
  const auth = new StaticTokenAuthenticator({ mgr, svc });
  return new App({ authenticator: auth, units: [{ id: 'u-1', tenantId: 't1' }], now: () => '2026-07-01T00:00:00Z' });
}

/** Register an active fiscal integration + an invoice billed to a party with a tax id. */
function seed(app: App) {
  D(app, 'POST', '/integrations', 'mgr', { id: 'fisc1', kind: 'fiscal', provider: 'generic_rest', config: { baseUrl: 'https://nfe.example.com' }, secretRef: 'FOCUS_NFE_KEY' });
  D(app, 'POST', '/parties', 'mgr', { id: 'p-ana', kind: 'person', displayName: 'Ana', taxId: '123.456.789-00' });
  D(app, 'POST', '/agreements', 'mgr', { id: 'ag1', unitId: 'u-1', guestId: 'p-ana', kind: 'monthly', start: '2026-07-01', end: '2026-12-31', rateCents: 300000 });
  D(app, 'POST', '/agreements/ag1/parties', 'mgr', { partyId: 'p-ana', role: 'resident' });
  D(app, 'POST', '/invoices', 'mgr', { id: 'inv1', agreementId: 'ag1', dueAt: '2026-07-10', lines: [{ description: 'Rent', account: 'revenue:room', amountCents: 300000 }] });
}

// ---- contract -------------------------------------------------------------

test('the fiscal kind is in the contract with emit/cancel actions and authorization events', () => {
  assert.ok(isKnownAction('fiscal', 'emit_invoice'));
  assert.ok(isKnownAction('fiscal', 'cancel_invoice'));
  assert.ok(!isKnownAction('fiscal', 'charge')); // not a fiscal action
  assert.ok(isKnownEvent('fiscal', 'invoice_authorized'));
  assert.ok(isKnownEvent('fiscal', 'invoice_rejected'));
  assert.ok(fullContract().some((c) => c.kind === 'fiscal'));
  assert.ok(KIND_ACTIONS.fiscal.length >= 2 && KIND_EVENTS.fiscal.length >= 2);
});

// ---- adapter --------------------------------------------------------------

test('the generic_fiscal adapter builds a credential-free emit_invoice request', () => {
  const req = genericFiscal.buildRequest('emit_invoice', { invoiceId: 'inv1', totalCents: 300000 }, { baseUrl: 'https://nfe.example.com' });
  assert.equal(req.method, 'POST');
  assert.equal(req.url, 'https://nfe.example.com/nfe');
  assert.deepEqual(req.auth, { scheme: 'bearer' }); // a descriptor, not a secret
  assert.equal((req.body as { invoiceId: string }).invoiceId, 'inv1');
  assert.ok(!JSON.stringify(req).toLowerCase().includes('secret'));
});

test('the fiscal adapter is enabled and in the default registry', () => {
  assert.equal(genericFiscal.enabled, true); // fiscal is not a money rail
  assert.ok(defaultAdapterRegistry().resolve('fiscal', 'generic_rest'));
});

test('the fiscal adapter rejects an unsupported action', () => {
  assert.throws(() => genericFiscal.buildRequest('charge', {}, { baseUrl: 'https://x' }), AdapterError);
});

// ---- routing policy -------------------------------------------------------

test('fiscal is a dispatchable, non-money kind', () => {
  assert.ok(DISPATCHABLE_KINDS.includes('fiscal'));
  assert.ok(!MONEY_KINDS.includes('fiscal'));
});

test('planConnectorCommand dispatches a fiscal emit with a resolved secret, rejects without', () => {
  assert.equal(planConnectorCommand({ action: 'emit_invoice', kind: 'fiscal', secretResolved: true }).decision, 'dispatch');
  assert.equal(planConnectorCommand({ action: 'emit_invoice', kind: 'fiscal', secretResolved: false }).decision, 'reject');
});

// ---- emission endpoint ----------------------------------------------------

test('POST /invoices/:id/emit-nfe enqueues a credential-free command with the recipient tax id', () => {
  const app = makeApp();
  seed(app);
  const r = D(app, 'POST', '/invoices/inv1/emit-nfe', 'mgr');
  assert.equal(r.status, 202);
  const cmd = (r.body as { command: { id: string; action: string; payload: Record<string, unknown> } }).command;
  assert.equal(cmd.action, 'emit_invoice');
  const payload = cmd.payload as { totalCents: number; recipient: { taxId: string }; _request: { url: string } };
  assert.equal(payload.totalCents, 300000);
  assert.equal(payload.recipient.taxId, '123.456.789-00');
  assert.equal(payload._request.url, 'https://nfe.example.com/nfe'); // adapter attached the vendor request
  // Credential never enters the kernel — only the secretRef pointer on the integration.
  assert.ok(!JSON.stringify(cmd).includes('FOCUS_NFE_KEY'));
});

test('the enqueued command appears in the connector outbox as pending', () => {
  const app = makeApp();
  seed(app);
  D(app, 'POST', '/invoices/inv1/emit-nfe', 'mgr');
  const cmds = (D(app, 'GET', '/connector-commands', 'mgr').body as { commands: Array<{ id: string; status: string }> }).commands;
  assert.ok(cmds.some((c) => c.id === 'nfe-inv1' && c.status === 'pending'));
});

test('emit-nfe is 409 when no active fiscal integration is configured', () => {
  const app = makeApp();
  D(app, 'POST', '/parties', 'mgr', { id: 'p-ana', kind: 'person', displayName: 'Ana' });
  D(app, 'POST', '/agreements', 'mgr', { id: 'ag1', unitId: 'u-1', guestId: 'p-ana', kind: 'monthly', start: '2026-07-01', end: '2026-12-31', rateCents: 300000 });
  D(app, 'POST', '/agreements/ag1/parties', 'mgr', { partyId: 'p-ana', role: 'resident' });
  D(app, 'POST', '/invoices', 'mgr', { id: 'inv1', agreementId: 'ag1', dueAt: '2026-07-10', lines: [{ description: 'Rent', account: 'revenue:room', amountCents: 300000 }] });
  assert.equal(D(app, 'POST', '/invoices/inv1/emit-nfe', 'mgr').status, 409);
});

test('emit-nfe is 404 for an unknown invoice', () => {
  const app = makeApp();
  seed(app);
  assert.equal(D(app, 'POST', '/invoices/nope/emit-nfe', 'mgr').status, 404);
});

test('re-emitting the same invoice is refused (idempotent command id)', () => {
  const app = makeApp();
  seed(app);
  assert.equal(D(app, 'POST', '/invoices/inv1/emit-nfe', 'mgr').status, 202);
  assert.equal(D(app, 'POST', '/invoices/inv1/emit-nfe', 'mgr').status, 409); // duplicate nfe-inv1
});

// ---- inbound authorization -----------------------------------------------

test('an inbound fiscal invoice_authorized event is recorded (service role)', () => {
  const app = makeApp();
  seed(app);
  const r = D(app, 'POST', '/integrations/fisc1/events', 'svc', { event: 'invoice_authorized', eventId: 'nfe-auth-1', payload: { invoiceId: 'inv1', fiscalRef: 'NFe3512...', accessKey: '3512...' } });
  assert.equal(r.status, 201);
  assert.equal((r.body as { routed: string }).routed, 'recorded');
});

test('an unknown fiscal event is rejected', () => {
  const app = makeApp();
  seed(app);
  assert.equal(D(app, 'POST', '/integrations/fisc1/events', 'svc', { event: 'nonsense', eventId: 'x' }).status, 400);
});
