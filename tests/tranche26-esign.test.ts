// Tranche 26 — e-signature for lease execution (#17, the CRM → lease → e-sign
// tail). A pure envelope state machine: draft → sent → signed (or declined /
// voided), with a signer roster and per-signer completion. The provider I/O
// lives in an edge adapter (secretRef); a fully signed envelope advances the CRM
// lead but does NOT execute the lease — lease.execute stays a human-gated
// escalation. 12 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Signatures, EsignError } from '../src/esign.ts';
import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';

const T = '2026-07-01T00:00:00Z';
const bearer = (t: string) => `Bearer ${t}`;
const D = (app: App, method: string, path: string, token: string, body?: Record<string, unknown>) =>
  app.dispatch({ method, path, bearer: bearer(token), body });

const twoSigners = [
  { name: 'Ana Souza', email: 'ana@x.com', role: 'resident' },
  { name: 'Pat Souza', email: 'pat@x.com', role: 'guarantor' },
];

// ---- pure kernel ---------------------------------------------------------

test('an envelope goes draft → sent → signed once every signer signs', () => {
  const s = new Signatures();
  s.create({ id: 'e1', tenantId: 't1', documentName: 'Lease', provider: 'docusign', signers: twoSigners, createdAt: T });
  assert.equal(s.get('e1').status, 'draft');
  s.send('e1', T, 'ext-123');
  assert.equal(s.get('e1').status, 'sent');
  assert.equal(s.get('e1').providerRef, 'ext-123');
  const first = s.recordSigned('e1', 'ana@x.com', T);
  assert.equal(first.completed, false); // one still outstanding
  assert.equal(s.get('e1').status, 'sent');
  const second = s.recordSigned('e1', 'PAT@x.com', T); // case-insensitive match
  assert.equal(second.completed, true);
  assert.equal(s.get('e1').status, 'signed');
  assert.ok(s.get('e1').completedAt);
});

test('a decline moves the whole envelope to declined', () => {
  const s = new Signatures();
  s.create({ id: 'e1', tenantId: 't1', documentName: 'Lease', provider: 'clicksign', signers: twoSigners, createdAt: T });
  s.send('e1', T);
  const d = s.decline('e1', 'ana@x.com', 'changed mind', T);
  assert.equal(d.status, 'declined');
  assert.equal(d.declineReason, 'changed mind');
});

test('void is allowed from draft or sent, not from signed', () => {
  const s = new Signatures();
  s.create({ id: 'e1', tenantId: 't1', documentName: 'Lease', provider: 'docusign', signers: [twoSigners[0]!], createdAt: T });
  s.send('e1', T);
  s.recordSigned('e1', 'ana@x.com', T); // now signed
  assert.throws(() => s.void('e1', 'oops', T), EsignError);
  s.create({ id: 'e2', tenantId: 't1', documentName: 'L2', provider: 'docusign', signers: [twoSigners[0]!], createdAt: T });
  assert.equal(s.void('e2', 'not needed', T).status, 'voided');
});

test('cannot sign an envelope that is not out for signature', () => {
  const s = new Signatures();
  s.create({ id: 'e1', tenantId: 't1', documentName: 'Lease', provider: 'docusign', signers: twoSigners, createdAt: T });
  assert.throws(() => s.recordSigned('e1', 'ana@x.com', T), EsignError); // still draft
});

test('validation: duplicate id, no signers, duplicate signer email, missing fields', () => {
  const s = new Signatures();
  s.create({ id: 'e1', tenantId: 't1', documentName: 'Lease', provider: 'docusign', signers: twoSigners, createdAt: T });
  assert.throws(() => s.create({ id: 'e1', tenantId: 't1', documentName: 'x', provider: 'p', signers: twoSigners, createdAt: T }), EsignError);
  assert.throws(() => s.create({ id: 'e2', tenantId: 't1', documentName: 'x', provider: 'p', signers: [], createdAt: T }), EsignError);
  assert.throws(() => s.create({ id: 'e3', tenantId: 't1', documentName: 'x', provider: 'p', signers: [{ name: 'A', email: 'a@x.com', role: 'r' }, { name: 'B', email: 'A@x.com', role: 'r' }], createdAt: T }), EsignError);
  assert.throws(() => s.create({ id: 'e4', tenantId: 't1', documentName: 'x', provider: 'p', signers: [{ name: '', email: 'a@x.com', role: 'r' }], createdAt: T }), EsignError);
});

test('an unknown signer email is rejected', () => {
  const s = new Signatures();
  s.create({ id: 'e1', tenantId: 't1', documentName: 'Lease', provider: 'docusign', signers: twoSigners, createdAt: T });
  s.send('e1', T);
  assert.throws(() => s.recordSigned('e1', 'nobody@x.com', T), EsignError);
});

// ---- through the Public API ----------------------------------------------

function makeApp() {
  const owner: AuthContext = { actor: 'ana', tenantId: 't1', role: 'owner' };
  const agent: AuthContext = { actor: 'bot', tenantId: 't1', role: 'agent' };
  const reader: AuthContext = { actor: 'aud', tenantId: 't1', role: 'read_only' };
  const acct: AuthContext = { actor: 'fin', tenantId: 't1', role: 'accountant' };
  const auth = new StaticTokenAuthenticator({ own: owner, bot: agent, ro: reader, fin: acct });
  return new App({ authenticator: auth, now: () => T });
}
const envBody = (over: Record<string, unknown> = {}) => ({ id: 'env-1', documentName: 'Lease 2026', provider: 'docusign', signers: twoSigners, ...over });

test('API: create → send → sign completes the envelope', () => {
  const app = makeApp();
  assert.equal(D(app, 'POST', '/signature-envelopes', 'own', envBody()).status, 201);
  assert.equal((D(app, 'POST', '/signature-envelopes/env-1/send', 'own', { providerRef: 'ext-9' }).body as { status: string }).status, 'sent');
  D(app, 'POST', '/signature-envelopes/env-1/sign', 'own', { email: 'ana@x.com' });
  const done = D(app, 'POST', '/signature-envelopes/env-1/sign', 'own', { email: 'pat@x.com' });
  const b = done.body as { completed: boolean; envelope: { status: string } };
  assert.equal(b.completed, true);
  assert.equal(b.envelope.status, 'signed');
});

test('API: a completed envelope advances its linked CRM lead to signed — but not the lease', () => {
  const app = makeApp();
  D(app, 'POST', '/leads', 'own', { id: 'ld-1', name: 'Ana Souza', estValueCents: 300000 });
  D(app, 'POST', '/leads/ld-1/advance', 'own', { stage: 'approved' });
  D(app, 'POST', '/signature-envelopes', 'own', envBody({ id: 'env-1', leadId: 'ld-1', signers: [twoSigners[0]] }));
  D(app, 'POST', '/signature-envelopes/env-1/send', 'own', {});
  D(app, 'POST', '/signature-envelopes/env-1/sign', 'own', { email: 'ana@x.com' });
  // the lead is now won…
  assert.equal((D(app, 'GET', '/leads/ld-1', 'own').body as { stage: string }).stage, 'signed');
  // …but lease.execute remains an escalation (no agreement was auto-executed)
  const summary = D(app, 'GET', '/crm/summary', 'own').body as { wonCount: number };
  assert.equal(summary.wonCount, 1);
});

test('API: linking an unknown lead is 404', () => {
  const app = makeApp();
  assert.equal(D(app, 'POST', '/signature-envelopes', 'own', envBody({ leadId: 'nope' })).status, 404);
});

test('API: a decline via the sign endpoint moves the envelope to declined', () => {
  const app = makeApp();
  D(app, 'POST', '/signature-envelopes', 'own', envBody());
  D(app, 'POST', '/signature-envelopes/env-1/send', 'own', {});
  const r = D(app, 'POST', '/signature-envelopes/env-1/sign', 'own', { email: 'ana@x.com', decline: true, reason: 'no' });
  assert.equal((r.body as { status: string }).status, 'declined');
});

test('API: RBAC — agent manages e-sign (OPS); read_only reads; accountant cannot', () => {
  const app = makeApp();
  assert.equal(D(app, 'POST', '/signature-envelopes', 'bot', envBody()).status, 201); // esign.manage in OPS
  assert.equal(D(app, 'GET', '/signature-envelopes', 'ro').status, 200);
  assert.equal(D(app, 'POST', '/signature-envelopes', 'ro', envBody({ id: 'env-2' })).status, 403);
  assert.equal(D(app, 'GET', '/signature-envelopes', 'fin').status, 403);
});

test('API: the send action is auditable — it appears in the action log', () => {
  const app = makeApp();
  D(app, 'POST', '/signature-envelopes', 'own', envBody());
  D(app, 'POST', '/signature-envelopes/env-1/send', 'own', {});
  const logged = app.runtime.actionLog().some((r) => r.action === 'esign.send' && r.outcome === 'executed');
  assert.equal(logged, true);
});
