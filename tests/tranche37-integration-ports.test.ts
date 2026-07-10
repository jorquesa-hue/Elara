// Tranche 37 — integration ports: the per-kind capability contract + the
// pluggable vendor adapter registry. A vendor is onboarded by registering ONE
// pure adapter that translates canonical commands into vendor request templates;
// no credential ever enters the kernel. 17 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { KIND_ACTIONS, KIND_EVENTS, isKnownAction, isKnownEvent, fullContract } from '../src/integration-contract.ts';
import {
  AdapterRegistry, AdapterError, defaultAdapterRegistry,
  genericRestAccessControl, genericRestBank, type Adapter,
} from '../src/adapter-registry.ts';
import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';

const bearer = (t: string) => `Bearer ${t}`;
const D = (app: App, method: string, path: string, token: string, body?: Record<string, unknown>) =>
  app.dispatch({ method, path, bearer: bearer(token), body });
function makeApp() {
  const owner: AuthContext = { actor: 'ana', tenantId: 't1', role: 'owner' };
  return new App({ authenticator: new StaticTokenAuthenticator({ own: owner }), now: () => '2026-07-01T00:00:00Z' });
}

// ---- contract ------------------------------------------------------------

test('every integration kind has a canonical action + event vocabulary', () => {
  for (const kind of Object.keys(KIND_ACTIONS) as Array<keyof typeof KIND_ACTIONS>) {
    assert.ok(KIND_ACTIONS[kind].length > 0, `${kind} actions`);
    assert.ok(KIND_EVENTS[kind].length > 0, `${kind} events`);
  }
});

test('isKnownAction / isKnownEvent validate against the contract', () => {
  assert.equal(isKnownAction('access_control', 'unlock_door'), true);
  assert.equal(isKnownAction('access_control', 'teleport'), false);
  assert.equal(isKnownEvent('bank', 'transaction_posted'), true);
  assert.equal(isKnownEvent('bank', 'made_up'), false);
});

test('fullContract lists every kind for discovery', () => {
  const c = fullContract();
  assert.equal(c.length, Object.keys(KIND_ACTIONS).length);
  assert.ok(c.find((k) => k.kind === 'bank')!.actions.some((a) => a.action === 'initiate_payout'));
});

// ---- registry ------------------------------------------------------------

test('the default registry ships the generic reference adapters', () => {
  const reg = defaultAdapterRegistry();
  assert.ok(reg.resolve('access_control', 'generic_rest'));
  assert.ok(reg.resolve('website', 'generic_webhook'));
  assert.equal(reg.resolve('elevator', 'nobody'), null);
});

test('registering an adapter whose action is not in the contract throws', () => {
  const bad: Adapter = { kind: 'lock', provider: 'x', actions: ['explode'], enabled: true, buildRequest: () => ({ method: 'GET', url: '', auth: { scheme: 'none' } }) };
  assert.throws(() => new AdapterRegistry().register(bad), AdapterError);
});

test('onboarding a NEW vendor is just registering one adapter (no core change)', () => {
  const salto: Adapter = {
    kind: 'access_control', provider: 'salto', actions: ['unlock_door', 'list_doors'], enabled: true,
    buildRequest(action, payload, config) {
      const base = String(config['baseUrl']);
      if (action === 'unlock_door') return { method: 'POST', url: `${base}/v1/doors/${payload['doorId']}/open`, auth: { scheme: 'header', name: 'Authorization' } };
      return { method: 'GET', url: `${base}/v1/doors`, auth: { scheme: 'header', name: 'Authorization' } };
    },
  };
  const reg = defaultAdapterRegistry().register(salto);
  const req = reg.resolve('access_control', 'salto')!.buildRequest('unlock_door', { doorId: 'D9' }, { baseUrl: 'https://salto.example' });
  assert.equal(req.url, 'https://salto.example/v1/doors/D9/open');
  assert.equal(req.method, 'POST');
});

// ---- pure translation (no credential ever present) -----------------------

test('buildRequest produces a vendor request template with an auth DESCRIPTOR, not a secret', () => {
  const req = genericRestAccessControl.buildRequest('unlock_door', { doorId: 'lobby', until: '2026-07-01T12:00:00Z' }, { baseUrl: 'https://acme.io/' });
  assert.equal(req.method, 'POST');
  assert.equal(req.url, 'https://acme.io/doors/lobby/unlock'); // trailing slash normalised
  assert.deepEqual(req.auth, { scheme: 'bearer' }); // the edge injects the secret; the template holds none
  assert.deepEqual(req.body, { until: '2026-07-01T12:00:00Z' });
});

test('buildRequest URL-encodes identifiers', () => {
  const req = genericRestAccessControl.buildRequest('revoke_access', { credential: 'a/b c' }, { baseUrl: 'https://x.io' });
  assert.equal(req.url, 'https://x.io/access/a%2Fb%20c');
});

test('an adapter requires its config (baseUrl) and refuses an unsupported action', () => {
  assert.throws(() => genericRestAccessControl.buildRequest('unlock_door', {}, {}), AdapterError); // no baseUrl
  assert.throws(() => genericRestAccessControl.buildRequest('nope', {}, { baseUrl: 'https://x' }), AdapterError);
});

// ---- money-rail guardrail at the adapter layer ---------------------------

test('the bank port EXISTS but ships DISABLED (payout needs human sign-off)', () => {
  assert.equal(genericRestBank.enabled, false);
  assert.equal(defaultAdapterRegistry().resolve('bank', 'generic_rest')!.enabled, false);
});

test('the bank adapter still translates (the port is real) — dispatch is gated elsewhere', () => {
  // buildRequest works so the capability is genuine; enabling + the routing policy
  // (planConnectorCommand refuses money kinds) are the two gates that keep it safe.
  const req = genericRestBank.buildRequest('get_balance', {}, { baseUrl: 'https://bank.example' });
  assert.equal(req.url, 'https://bank.example/balance');
});

// ---- API: capability discovery + build-at-enqueue ------------------------

test('API: GET /integrations/capabilities exposes the full contract', () => {
  const app = makeApp();
  const c = (D(app, 'GET', '/integrations/capabilities', 'own').body as { contract: Array<{ kind: string }> }).contract;
  assert.ok(c.find((k) => k.kind === 'access_control'));
});

test('API: registering a generic_rest access-control integration → its capabilities resolve', () => {
  const app = makeApp();
  D(app, 'POST', '/integrations', 'own', { id: 'int-ac', kind: 'access_control', provider: 'generic_rest', config: { baseUrl: 'https://acme.io' }, secretRef: 'acme-key' });
  const caps = D(app, 'GET', '/integrations/int-ac/capabilities', 'own').body as { adapterRegistered: boolean; enabled: boolean; actions: string[] };
  assert.equal(caps.adapterRegistered, true);
  assert.equal(caps.enabled, true);
  assert.ok(caps.actions.includes('unlock_door'));
});

test('API: a canonical command attaches a credential-free _request for the edge', () => {
  const app = makeApp();
  D(app, 'POST', '/integrations', 'own', { id: 'int-ac', kind: 'access_control', provider: 'generic_rest', config: { baseUrl: 'https://acme.io' }, secretRef: 'acme-key' });
  const cmd = D(app, 'POST', '/integrations/int-ac/commands', 'own', { id: 'c-1', action: 'unlock_door', payload: { doorId: 'lobby' } });
  assert.equal(cmd.status, 201);
  const req = (cmd.body as { payload: { _request?: { url: string; auth: unknown } } }).payload._request!;
  assert.equal(req.url, 'https://acme.io/doors/lobby/unlock');
  assert.deepEqual(req.auth, { scheme: 'bearer' }); // a descriptor, never the secret
});

test('API: an action the vendor adapter does not support is rejected (400)', () => {
  const app = makeApp();
  D(app, 'POST', '/integrations', 'own', { id: 'int-ac', kind: 'access_control', provider: 'generic_rest', config: { baseUrl: 'https://acme.io' }, secretRef: 'k' });
  assert.equal(D(app, 'POST', '/integrations/int-ac/commands', 'own', { id: 'c-x', action: 'launch_rocket', payload: {} }).status, 400);
});

test('API: a DISABLED money adapter attaches NO _request (payout not auto-built)', () => {
  const app = makeApp();
  D(app, 'POST', '/integrations', 'own', { id: 'int-bank', kind: 'bank', provider: 'generic_rest', config: { baseUrl: 'https://bank.io' }, secretRef: 'bk' });
  const cmd = D(app, 'POST', '/integrations/int-bank/commands', 'own', { id: 'c-b', action: 'get_balance', payload: {} });
  assert.equal(cmd.status, 201);
  assert.equal((cmd.body as { payload: { _request?: unknown } }).payload._request, undefined);
});

test('API: an unknown vendor (no adapter) still enqueues — back-compat', () => {
  const app = makeApp();
  D(app, 'POST', '/integrations', 'own', { id: 'int-x', kind: 'lock', provider: 'obscure_vendor', config: {}, secretRef: 'k' });
  const cmd = D(app, 'POST', '/integrations/int-x/commands', 'own', { id: 'c-o', action: 'anything.goes', payload: {} });
  assert.equal(cmd.status, 201);
  assert.equal((cmd.body as { payload: { _request?: unknown } }).payload._request, undefined);
});
