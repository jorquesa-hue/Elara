// Tranche 39 — the login flow: GET /auth/config (public, pre-auth) tells the SPA
// how to sign in, and a real GoTrue-shaped JWT (claims under app_metadata) is
// verified end-to-end by the JwtAuthenticator. 6 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, JwtAuthenticator, type AuthContext } from '../src/api/context.ts';

const NOW = 1_800_000_000;
const b64url = (v: Buffer | string) => Buffer.from(v).toString('base64url');
function mint(payload: Record<string, unknown>, secret: string) {
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify(payload));
  return `${h}.${p}.${b64url(createHmac('sha256', secret).update(`${h}.${p}`).digest())}`;
}

// ---- /auth/config is public (the SPA needs it BEFORE it has a token) ------

test('GET /auth/config returns dev mode when no auth is configured — no token needed', () => {
  const app = new App({ authenticator: new StaticTokenAuthenticator({}), now: () => 'T' });
  const r = app.dispatch({ method: 'GET', path: '/auth/config' }); // no bearer
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { mode: 'dev' });
});

test('GET /auth/config advertises the Supabase auth endpoint + public anon key', () => {
  const app = new App({
    authenticator: new StaticTokenAuthenticator({}),
    authConfig: { authUrl: 'https://ref.supabase.co/auth/v1', anonKey: 'anon-public-key' },
    now: () => 'T',
  });
  const r = app.dispatch({ method: 'GET', path: '/auth/config' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { mode: 'supabase', authUrl: 'https://ref.supabase.co/auth/v1', anonKey: 'anon-public-key' });
});

test('every OTHER route still requires a valid token (config is the only public one)', () => {
  const app = new App({ authenticator: new StaticTokenAuthenticator({}), now: () => 'T' });
  assert.equal(app.dispatch({ method: 'GET', path: '/health' }).status, 401);
  assert.equal(app.dispatch({ method: 'GET', path: '/countries' }).status, 401);
});

// ---- a real GoTrue-issued JWT authenticates end-to-end -------------------

test('a GoTrue JWT with claims under app_metadata authenticates and is scoped', () => {
  const secret = 'the-project-jwt-secret';
  const app = new App({ authenticator: new JwtAuthenticator({ secret, now: () => NOW }), now: () => 'T' });
  // Supabase puts custom claims in app_metadata; the top-level `role` is GoTrue's.
  const token = mint({ sub: 'user-uuid', role: 'authenticated', app_metadata: { tenant_id: 't-acme', user_role: 'manager' }, exp: NOW + 3600 }, secret);
  const me = app.dispatch({ method: 'GET', path: '/me', bearer: `Bearer ${token}` });
  assert.equal(me.status, 200);
  const body = me.body as { tenantId: string; role: string };
  assert.equal(body.tenantId, 't-acme');
  assert.equal(body.role, 'manager');
});

test('a GoTrue JWT signed with the wrong secret is rejected (401)', () => {
  const app = new App({ authenticator: new JwtAuthenticator({ secret: 'right', now: () => NOW }), now: () => 'T' });
  const token = mint({ sub: 'u', app_metadata: { tenant_id: 't', user_role: 'owner' }, exp: NOW + 3600 }, 'wrong');
  assert.equal(app.dispatch({ method: 'GET', path: '/health', bearer: `Bearer ${token}` }).status, 401);
  // …but /auth/config is still reachable (public), so the SPA can show the login.
  assert.equal(app.dispatch({ method: 'GET', path: '/auth/config' }).status, 200);
});

test('a party-scoped GoTrue JWT carries party_id (guest self-service)', () => {
  const secret = 's';
  const app = new App({ authenticator: new JwtAuthenticator({ secret, now: () => NOW }), now: () => 'T' });
  const token = mint({ sub: 'p-1', app_metadata: { tenant_id: 't', user_role: 'guest', party_id: 'p-1' }, exp: NOW + 3600 }, secret);
  const me = app.dispatch({ method: 'GET', path: '/me', bearer: `Bearer ${token}` });
  assert.equal(me.status, 200);
  assert.equal((me.body as { partyId?: string }).partyId, 'p-1');
});
