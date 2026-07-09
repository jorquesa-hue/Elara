// Tranche 18 — Phase 2 module 4: communications (#4). Threaded messages between
// residents, finance, and internal teams; agent-authored sends pass the policy
// envelope like any agent action. 10 tests.

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
  const agent: AuthContext = { actor: 'bot', tenantId: 't1', role: 'agent' };
  const reader: AuthContext = { actor: 'aud', tenantId: 't1', role: 'read_only' };
  const other: AuthContext = { actor: 'sp', tenantId: 't2', role: 'owner' };
  const auth = new StaticTokenAuthenticator({ own: owner, bot: agent, ro: reader, sp: other });
  const app = new App({ authenticator: auth, units: [{ id: 'u-1', tenantId: 't1' }], now: () => T });
  D(app, 'POST', '/parties', 'own', { id: 'p-res', kind: 'person', displayName: 'Resident' });
  D(app, 'POST', '/agreements', 'own', { id: 'ag-1', guestId: 'g-1', unitId: 'u-1', kind: 'monthly', start: '2026-07-01', end: '2027-07-01', rateCents: 300000 });
  return app;
}

test('open a resident thread and exchange messages; direction is inferred', () => {
  const app = makeApp();
  assert.equal(D(app, 'POST', '/threads', 'own', { id: 'th-1', subject: 'AC not working', kind: 'resident', agreementId: 'ag-1', partyId: 'p-res' }).status, 201);
  const inbound = D(app, 'POST', '/threads/th-1/messages', 'own', { id: 'm-1', body: 'My AC is broken', authorType: 'party' });
  assert.equal((inbound.body as { direction: string }).direction, 'inbound');
  const outbound = D(app, 'POST', '/threads/th-1/messages', 'own', { id: 'm-2', body: 'A tech is on the way' });
  assert.equal((outbound.body as { direction: string; authorType: string }).direction, 'outbound');
  const view = D(app, 'GET', '/threads/th-1', 'own').body as { messages: unknown[] };
  assert.equal(view.messages.length, 2);
});

test('an agent-sent message is recorded as authorType=agent (#4)', () => {
  const app = makeApp();
  D(app, 'POST', '/threads', 'own', { id: 'th-a', subject: 'Rent reminder', kind: 'finance', agreementId: 'ag-1' });
  const m = D(app, 'POST', '/threads/th-a/messages', 'bot', { id: 'm-bot', body: 'Friendly reminder your rent is due.' });
  assert.equal(m.status, 201);
  assert.equal((m.body as { authorType: string }).authorType, 'agent');
});

test('internal threads mark messages internal', () => {
  const app = makeApp();
  D(app, 'POST', '/threads', 'own', { id: 'th-i', subject: 'Handover notes', kind: 'internal' });
  const m = D(app, 'POST', '/threads/th-i/messages', 'own', { id: 'm-i', body: 'Left keys at front desk' });
  assert.equal((m.body as { direction: string }).direction, 'internal');
});

test('cannot post to a resolved thread; reopening restores it', () => {
  const app = makeApp();
  D(app, 'POST', '/threads', 'own', { id: 'th-r', subject: 'x', kind: 'resident' });
  D(app, 'POST', '/threads/th-r/resolve', 'own', {});
  assert.equal(D(app, 'POST', '/threads/th-r/messages', 'own', { id: 'm-x', body: 'hi' }).status, 409);
  D(app, 'POST', '/threads/th-r/reopen', 'own', {});
  assert.equal(D(app, 'POST', '/threads/th-r/messages', 'own', { id: 'm-y', body: 'hi again' }).status, 201);
});

test('thread scoped to an unknown agreement or party is 404', () => {
  const app = makeApp();
  assert.equal(D(app, 'POST', '/threads', 'own', { id: 'th-bad', subject: 'x', kind: 'resident', agreementId: 'ghost' }).status, 404);
  assert.equal(D(app, 'POST', '/threads', 'own', { id: 'th-bad2', subject: 'x', kind: 'resident', partyId: 'nobody' }).status, 404);
});

test('read_only can read threads but cannot send', () => {
  const app = makeApp();
  D(app, 'POST', '/threads', 'own', { id: 'th-1', subject: 'x', kind: 'resident' });
  assert.equal(D(app, 'POST', '/threads/th-1/messages', 'ro', { id: 'm', body: 'nope' }).status, 403);
  assert.equal(D(app, 'GET', '/threads', 'ro').status, 200);
});

test('threads are tenant-scoped', () => {
  const app = makeApp();
  D(app, 'POST', '/threads', 'own', { id: 'th-1', subject: 'x', kind: 'resident' });
  assert.equal(D(app, 'GET', '/threads/th-1', 'sp').status, 404);
  assert.equal((D(app, 'GET', '/threads', 'sp').body as { threads: unknown[] }).threads.length, 0);
});

test('missing subject/body is a 400/validation error', () => {
  const app = makeApp();
  assert.equal(D(app, 'POST', '/threads', 'own', { id: 'th-x', kind: 'resident' }).status, 400); // no subject
  D(app, 'POST', '/threads', 'own', { id: 'th-ok', subject: 's', kind: 'resident' });
  assert.equal(D(app, 'POST', '/threads/th-ok/messages', 'own', { id: 'm' }).status, 400); // no body
});

test('duplicate thread and duplicate message are rejected', () => {
  const app = makeApp();
  D(app, 'POST', '/threads', 'own', { id: 'th-1', subject: 's', kind: 'resident' });
  assert.equal(D(app, 'POST', '/threads', 'own', { id: 'th-1', subject: 's2', kind: 'resident' }).status, 409);
  D(app, 'POST', '/threads/th-1/messages', 'own', { id: 'm-1', body: 'a' });
  assert.equal(D(app, 'POST', '/threads/th-1/messages', 'own', { id: 'm-1', body: 'b' }).status, 409);
});

test('listing returns a tenant’s threads', () => {
  const app = makeApp();
  D(app, 'POST', '/threads', 'own', { id: 'th-1', subject: 'a', kind: 'resident' });
  D(app, 'POST', '/threads', 'own', { id: 'th-2', subject: 'b', kind: 'finance' });
  assert.equal((D(app, 'GET', '/threads', 'own').body as { threads: unknown[] }).threads.length, 2);
});
