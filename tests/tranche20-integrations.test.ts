// Tranche 20 — connector framework: the shared spine for door locks (#7),
// access control (#12), elevators (#13), banks (#14), website (#16), CRM (#17).
// The kernel holds only non-secret config + a policy-gated command outbox; a
// real credential never reaches it (register rejects secret-like keys). 11 tests.

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
  const fd: AuthContext = { actor: 'desk', tenantId: 't1', role: 'front_desk' };
  const agent: AuthContext = { actor: 'bot', tenantId: 't1', role: 'agent' };
  const reader: AuthContext = { actor: 'aud', tenantId: 't1', role: 'read_only' };
  const other: AuthContext = { actor: 'sp', tenantId: 't2', role: 'owner' };
  const auth = new StaticTokenAuthenticator({ own: owner, desk: fd, bot: agent, ro: reader, sp: other });
  return new App({ authenticator: auth, now: () => T });
}
const lock = (id = 'int-lock') => ({ id, kind: 'lock', provider: 'salto', config: { site: 'bldg-a', endpoint: 'https://api.salto' }, secretRef: 'salto-key' });

test('register a lock integration; the secret stays a reference, never a value', () => {
  const app = makeApp();
  const r = D(app, 'POST', '/integrations', 'own', lock());
  assert.equal(r.status, 201);
  const body = r.body as { status: string; secretRef: string; config: Record<string, unknown> };
  assert.equal(body.status, 'active');
  assert.equal(body.secretRef, 'salto-key');
  assert.ok(!('secret' in body.config) && !('apiKey' in body.config)); // only non-secret config kept
});

test('a secret-like config key is refused (credentials never enter the kernel)', () => {
  const app = makeApp();
  assert.equal(D(app, 'POST', '/integrations', 'own', { id: 'int-x', kind: 'crm', provider: 'salesforce', config: { api_key: 'sk-live-123' } }).status, 409);
  assert.equal(D(app, 'POST', '/integrations', 'own', { id: 'int-y', kind: 'lock', provider: 'yale', config: { password: 'hunter2' } }).status, 409);
});

test('a secret nested inside a config object is also refused (recursive scan)', () => {
  const app = makeApp();
  // Shallow scans miss this; the recursive guard must still catch it.
  assert.equal(D(app, 'POST', '/integrations', 'own', { id: 'int-n', kind: 'bank', provider: 'itau', config: { auth: { password: 'hunter2' } } }).status, 409);
  assert.equal(D(app, 'POST', '/integrations', 'own', { id: 'int-a', kind: 'crm', provider: 'zoho', config: { creds: [{ token: 'sk-live' }] } }).status, 409);
});

test('camelCase secret keys are refused (accessToken/clientSecret/privateKey)', () => {
  const app = makeApp();
  // Snake-case-only matching missed these; the collapsed-alphanumeric matcher catches them.
  assert.equal(D(app, 'POST', '/integrations', 'own', { id: 'int-c1', kind: 'crm', provider: 'sf', config: { accessToken: 'x' } }).status, 409);
  assert.equal(D(app, 'POST', '/integrations', 'own', { id: 'int-c2', kind: 'bank', provider: 'itau', config: { clientSecret: 'x' } }).status, 409);
  assert.equal(D(app, 'POST', '/integrations', 'own', { id: 'int-c3', kind: 'lock', provider: 'salto', config: { privateKey: 'x' } }).status, 409);
});

test('a secret in a connector-command payload is refused (jsonb is persisted verbatim)', () => {
  const app = makeApp();
  D(app, 'POST', '/integrations', 'own', lock());
  assert.equal(D(app, 'POST', '/integrations/int-lock/commands', 'own', { id: 'cmd-secret', action: 'lock.unlock', payload: { api_key: 'sk-live-123' } }).status, 409);
  // a clean payload still enqueues fine
  assert.equal(D(app, 'POST', '/integrations/int-lock/commands', 'own', { id: 'cmd-ok', action: 'lock.unlock', payload: { spaceId: 's-1' } }).status, 201);
});

test('enqueue a connector command (unlock a door) → pending in the outbox (#7)', () => {
  const app = makeApp();
  D(app, 'POST', '/integrations', 'own', lock());
  const cmd = D(app, 'POST', '/integrations/int-lock/commands', 'own', { id: 'cmd-1', action: 'lock.unlock', payload: { spaceId: 's-101', until: '2026-07-01T12:00:00Z' } });
  assert.equal(cmd.status, 201);
  const b = cmd.body as { status: string; action: string; payload: Record<string, unknown> };
  assert.equal(b.status, 'pending');
  assert.equal(b.action, 'lock.unlock');
  assert.equal(b.payload['spaceId'], 's-101');
});

test('the edge-worker lifecycle: pending → dispatched → succeeded', () => {
  const app = makeApp();
  D(app, 'POST', '/integrations', 'own', lock());
  D(app, 'POST', '/integrations/int-lock/commands', 'own', { id: 'cmd-1', action: 'lock.unlock' });
  assert.equal((D(app, 'POST', '/connector-commands/cmd-1/dispatch', 'own', {}).body as { status: string }).status, 'dispatched');
  const done = D(app, 'POST', '/connector-commands/cmd-1/result', 'own', { ok: true, result: { code: 200 } });
  assert.equal((done.body as { status: string }).status, 'succeeded');
  // A second result is rejected.
  assert.equal(D(app, 'POST', '/connector-commands/cmd-1/result', 'own', { ok: true }).status, 409);
});

test('a failed dispatch is recorded as failed', () => {
  const app = makeApp();
  D(app, 'POST', '/integrations', 'own', lock());
  D(app, 'POST', '/integrations/int-lock/commands', 'own', { id: 'cmd-f', action: 'lock.unlock' });
  D(app, 'POST', '/connector-commands/cmd-f/dispatch', 'own', {});
  assert.equal((D(app, 'POST', '/connector-commands/cmd-f/result', 'own', { ok: false, result: { error: 'offline' } }).body as { status: string }).status, 'failed');
});

test('commands cannot be enqueued on a disabled integration', () => {
  const app = makeApp();
  D(app, 'POST', '/integrations', 'own', lock());
  D(app, 'POST', '/integrations/int-lock/status', 'own', { status: 'disabled' });
  assert.equal(D(app, 'POST', '/integrations/int-lock/commands', 'own', { id: 'cmd-z', action: 'lock.unlock' }).status, 409);
  D(app, 'POST', '/integrations/int-lock/status', 'own', { status: 'active' });
  assert.equal(D(app, 'POST', '/integrations/int-lock/commands', 'own', { id: 'cmd-z2', action: 'lock.unlock' }).status, 201);
});

test('enqueue on an unknown integration is 404', () => {
  const app = makeApp();
  assert.equal(D(app, 'POST', '/integrations/ghost/commands', 'own', { id: 'c', action: 'x' }).status, 404);
});

test('front desk may dispatch a command but not configure an integration', () => {
  const app = makeApp();
  D(app, 'POST', '/integrations', 'own', lock());
  assert.equal(D(app, 'POST', '/integrations', 'desk', lock('int-2')).status, 403); // integration.manage denied
  assert.equal(D(app, 'POST', '/integrations/int-lock/commands', 'desk', { id: 'c-fd', action: 'lock.unlock' }).status, 201); // connector.dispatch allowed
});

test('an AI agent may dispatch connector commands (autonomous concierge)', () => {
  const app = makeApp();
  D(app, 'POST', '/integrations', 'own', lock());
  assert.equal(D(app, 'POST', '/integrations/int-lock/commands', 'bot', { id: 'c-bot', action: 'lock.unlock' }).status, 201);
});

test('read_only may read integrations but not dispatch', () => {
  const app = makeApp();
  D(app, 'POST', '/integrations', 'own', lock());
  assert.equal(D(app, 'GET', '/integrations', 'ro').status, 200);
  assert.equal(D(app, 'POST', '/integrations/int-lock/commands', 'ro', { id: 'c-ro', action: 'x' }).status, 403);
});

test('integrations and commands are tenant-scoped', () => {
  const app = makeApp();
  D(app, 'POST', '/integrations', 'own', lock());
  D(app, 'POST', '/integrations/int-lock/commands', 'own', { id: 'cmd-1', action: 'lock.unlock' });
  assert.equal((D(app, 'GET', '/integrations', 'sp').body as { integrations: unknown[] }).integrations.length, 0);
  assert.equal(D(app, 'POST', '/connector-commands/cmd-1/dispatch', 'sp', {}).status, 404);
});
