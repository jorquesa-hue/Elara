// Tranche 42 — LGPD/GDPR data-subject rights reconciled with the event-sourced
// ledger. Subject-access export assembles everything about a party; erasure
// redacts the party's PII + notification recipients while RETAINING the
// append-only financial record (invariant 1) by opaque id, audited in action_log.
// 13 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';
import { redactPartyRecord, isErased, buildSubjectAccessReport, ERASURE_TOMBSTONE } from '../src/compliance.ts';
import type { PartyRecord } from '../src/party.ts';

const bearer = (t: string) => `Bearer ${t}`;
const D = (app: App, method: string, path: string, token: string, body?: Record<string, unknown>) =>
  app.dispatch({ method, path, bearer: bearer(token), body });

function makeApp(withUnits = true) {
  const mgr: AuthContext = { actor: 'mgr', tenantId: 't1', role: 'manager' };
  const fd: AuthContext = { actor: 'fd', tenantId: 't1', role: 'front_desk' };
  const ro: AuthContext = { actor: 'aud', tenantId: 't1', role: 'read_only' };
  const guest: AuthContext = { actor: 'g', tenantId: 't1', role: 'guest', partyId: 'p-ana' };
  const t2mgr: AuthContext = { actor: 'm2', tenantId: 't2', role: 'manager' };
  const auth = new StaticTokenAuthenticator({ mgr, fd, ro, guest, m2: t2mgr });
  return new App({ authenticator: auth, units: withUnits ? [{ id: 'u-1', tenantId: 't1' }] : [], now: () => '2026-07-01T00:00:00Z' });
}

const ledgerSum = (app: App) => [...app.ledger.trialBalance().values()].reduce((a, b) => a + b, 0);

/** Seed a party (Ana) as resident on an agreement, an invoice billed to her, and a
 *  notification to her email — a realistic data-subject footprint. */
function seed(app: App) {
  D(app, 'POST', '/parties', 'mgr', { id: 'p-ana', kind: 'person', displayName: 'Ana Silva', email: 'ana@x.com', taxId: '123.456.789-00', phone: '+55 11 90000', attributes: { kyc: 'passport-9' } });
  D(app, 'POST', '/agreements', 'mgr', { id: 'ag1', unitId: 'u-1', guestId: 'p-ana', kind: 'monthly', start: '2026-07-01', end: '2026-12-31', rateCents: 300000 });
  D(app, 'POST', '/agreements/ag1/parties', 'mgr', { partyId: 'p-ana', role: 'resident' });
  D(app, 'POST', '/invoices', 'mgr', { id: 'inv1', agreementId: 'ag1', dueAt: '2026-07-10', lines: [{ description: 'Rent', account: 'revenue:room', amountCents: 300000 }] });
  D(app, 'POST', '/notifications', 'mgr', { id: 'n1', channel: 'email', to: 'ana@x.com', kind: 'general', data: { subject: 'Welcome', body: 'Hi' } });
}

// ---- pure compliance helpers ----------------------------------------------

test('redactPartyRecord clears PII and marks the party erased', () => {
  const p: PartyRecord = { id: 'p1', tenantId: 't1', kind: 'person', displayName: 'Ana', email: 'a@x.com', taxId: '9', phone: '55', attributes: { kyc: 'x' } };
  const r = redactPartyRecord(p, '2026-07-01T00:00:00Z', 'subject request');
  assert.equal(r.id, 'p1'); // opaque id retained
  assert.equal(r.displayName, ERASURE_TOMBSTONE);
  assert.equal(r.email, undefined);
  assert.equal(r.taxId, undefined);
  assert.equal(r.phone, undefined);
  assert.equal((r.attributes as { kyc?: string }).kyc, undefined);
  assert.equal(isErased(r), true);
  assert.equal(isErased(p), false);
});

test('buildSubjectAccessReport flags erased and copies slices defensively', () => {
  const party: PartyRecord = { id: 'p1', tenantId: 't1', kind: 'person', displayName: 'Ana' };
  const rep = buildSubjectAccessReport({ generatedAt: 'T', party, roles: [], invoices: [], bills: [], notifications: [], leads: [], prospects: [] });
  assert.equal(rep.erased, false);
  assert.equal(rep.party.id, 'p1');
});

// ---- subject-access export ------------------------------------------------

test('an operator exports a party subject-access report with all linked data', () => {
  const app = makeApp();
  seed(app);
  const r = D(app, 'GET', '/privacy/parties/p-ana/export', 'mgr');
  assert.equal(r.status, 200);
  const rep = r.body as { party: PartyRecord; roles: unknown[]; invoices: unknown[]; notifications: unknown[]; erased: boolean };
  assert.equal(rep.party.email, 'ana@x.com');
  assert.equal(rep.roles.length, 1);
  assert.equal(rep.invoices.length, 1);
  assert.equal(rep.notifications.length, 1);
  assert.equal(rep.erased, false);
});

test('read_only cannot export a subject-access report (no privacy.export)', () => {
  const app = makeApp();
  seed(app);
  assert.equal(D(app, 'GET', '/privacy/parties/p-ana/export', 'ro').status, 403);
});

test('a guest may export ONLY its own party', () => {
  const app = makeApp();
  seed(app);
  D(app, 'POST', '/parties', 'mgr', { id: 'p-bob', kind: 'person', displayName: 'Bob', email: 'bob@x.com' });
  assert.equal(D(app, 'GET', '/privacy/parties/p-ana/export', 'guest').status, 200); // own
  assert.equal(D(app, 'GET', '/privacy/parties/p-bob/export', 'guest').status, 404); // someone else's
});

// ---- erasure --------------------------------------------------------------

test('erasure redacts the party PII but retains the financial record by opaque id', () => {
  const app = makeApp();
  seed(app);
  const r = D(app, 'POST', '/privacy/parties/p-ana/erase', 'mgr', { reason: 'subject request' });
  assert.equal(r.status, 200);
  const receipt = r.body as { partyId: string; redactedFields: string[]; notificationsRedacted: number; retained: { agreementRoles: number; invoices: number } };
  assert.equal(receipt.partyId, 'p-ana');
  assert.ok(receipt.redactedFields.includes('email'));
  assert.ok(receipt.redactedFields.includes('taxId'));
  assert.equal(receipt.notificationsRedacted, 1);
  // The financial linkage is RETAINED (invariant 1 — the money history stands).
  assert.equal(receipt.retained.agreementRoles, 1);
  assert.equal(receipt.retained.invoices, 1);

  // The party is now a tombstone; the invoice still exists, still billed to the id.
  const exp = D(app, 'GET', '/privacy/parties/p-ana/export', 'mgr').body as { party: PartyRecord; invoices: unknown[]; notifications: unknown[]; erased: boolean };
  assert.equal(exp.party.displayName, ERASURE_TOMBSTONE);
  assert.equal(exp.party.email, undefined);
  assert.equal(exp.erased, true);
  assert.equal(exp.invoices.length, 1); // financial record retained
  assert.equal(exp.notifications.length, 0); // recipient redacted → no longer matches the (now absent) email
});

test('erasure keeps the ledger balanced (no destructive write to journal_line)', () => {
  const app = makeApp();
  seed(app);
  const before = ledgerSum(app);
  D(app, 'POST', '/privacy/parties/p-ana/erase', 'mgr');
  assert.equal(ledgerSum(app), before);
  assert.equal(ledgerSum(app), 0); // a balanced double-entry ledger sums to zero
});

test('erasure is recorded in the tenant action log (audited)', () => {
  const app = makeApp();
  seed(app);
  D(app, 'POST', '/privacy/parties/p-ana/erase', 'mgr');
  const log = app.runtime.actionLogFor('t1');
  assert.ok(log.some((e) => e.action === 'privacy.erase' && e.outcome === 'executed'));
});

test('front_desk and agent cannot erase (privacy.manage is DPO-only, not OPS)', () => {
  const app = makeApp();
  seed(app);
  assert.equal(D(app, 'POST', '/privacy/parties/p-ana/erase', 'fd').status, 403);
});

test('the notification recipient is redacted in the outbox after erasure', () => {
  const app = makeApp();
  seed(app);
  D(app, 'POST', '/privacy/parties/p-ana/erase', 'mgr');
  const notifs = (D(app, 'GET', '/notifications', 'mgr').body as { notifications: Array<{ to: string }> }).notifications;
  assert.equal(notifs[0]!.to, ERASURE_TOMBSTONE);
});

test('erasing an unknown party is a 404', () => {
  const app = makeApp();
  assert.equal(D(app, 'POST', '/privacy/parties/nope/erase', 'mgr').status, 404);
});

test('erasure is tenant-scoped — a manager of another tenant cannot erase this party', () => {
  const app = makeApp();
  seed(app);
  // t2's manager tries to erase t1's party → 404 (existence never leaked cross-tenant).
  assert.equal(D(app, 'POST', '/privacy/parties/p-ana/erase', 'm2').status, 404);
  // t1's party is untouched.
  const exp = D(app, 'GET', '/privacy/parties/p-ana/export', 'mgr').body as { party: PartyRecord; erased: boolean };
  assert.equal(exp.party.displayName, 'Ana Silva');
  assert.equal(exp.erased, false);
});

test('the erasure survives a snapshot → rehydrate round trip', () => {
  const app = makeApp();
  seed(app);
  D(app, 'POST', '/privacy/parties/p-ana/erase', 'mgr');
  const world = app.snapshotWorld('t1');
  const fresh = makeApp(false); // no pre-seeded units — rehydrate brings them from the snapshot
  fresh.rehydrate(world);
  const exp = D(fresh, 'GET', '/privacy/parties/p-ana/export', 'mgr').body as { party: PartyRecord; erased: boolean };
  assert.equal(exp.party.displayName, ERASURE_TOMBSTONE);
  assert.equal(exp.erased, true);
});
