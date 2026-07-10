// Tranche 32 — production JWT authenticator. A zero-npm-dep HS256 verifier
// (node:crypto) that derives the AuthContext from a signed token's claims,
// reading the same tenant_id claim the DB's RLS keys off. 9 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { JwtAuthenticator } from '../src/api/context.ts';

const SECRET = 'super-secret-signing-key';
const NOW = 1_800_000_000; // fixed clock (seconds)

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url');
}

/** Mint an HS256 JWT for tests. */
function mint(payload: Record<string, unknown>, opts: { secret?: string; alg?: string } = {}): string {
  const header = { alg: opts.alg ?? 'HS256', typ: 'JWT' };
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(payload));
  const sig = createHmac('sha256', opts.secret ?? SECRET).update(`${h}.${p}`).digest();
  return `${h}.${p}.${b64url(sig)}`;
}

function auth(overrides: Partial<ConstructorParameters<typeof JwtAuthenticator>[0]> = {}) {
  return new JwtAuthenticator({ secret: SECRET, now: () => NOW, ...overrides });
}

test('a validly signed token yields the AuthContext from its claims', () => {
  const a = auth();
  const token = mint({ sub: 'user-1', tenant_id: 't-rio', user_role: 'manager', exp: NOW + 3600 });
  const ctx = a.authenticate(`Bearer ${token}`);
  assert.deepEqual(ctx, { actor: 'user-1', tenantId: 't-rio', role: 'manager' });
});

test('a party_id claim is carried through (for guest/resident tokens)', () => {
  const a = auth();
  const token = mint({ sub: 'p-9', tenant_id: 't-rio', user_role: 'guest', party_id: 'p-9', exp: NOW + 3600 });
  assert.deepEqual(a.authenticate(`Bearer ${token}`), { actor: 'p-9', tenantId: 't-rio', role: 'guest', partyId: 'p-9' });
});

test('claims nested under app_metadata are read', () => {
  const a = auth();
  const token = mint({ sub: 'u-2', app_metadata: { tenant_id: 't-sp', user_role: 'accountant' }, exp: NOW + 3600 });
  assert.deepEqual(a.authenticate(`Bearer ${token}`), { actor: 'u-2', tenantId: 't-sp', role: 'accountant' });
});

test('a tampered payload is rejected (signature mismatch)', () => {
  const a = auth();
  const token = mint({ sub: 'u', tenant_id: 't-rio', user_role: 'owner', exp: NOW + 3600 });
  const [h, , s] = token.split('.');
  const forged = `${h}.${b64url(JSON.stringify({ sub: 'u', tenant_id: 't-rio', user_role: 'owner', exp: NOW + 3600, extra: 'x' }))}.${s}`;
  assert.equal(a.authenticate(`Bearer ${forged}`), null);
});

test('a token signed with the wrong secret is rejected', () => {
  const a = auth();
  const token = mint({ sub: 'u', tenant_id: 't-rio', user_role: 'owner', exp: NOW + 3600 }, { secret: 'attacker' });
  assert.equal(a.authenticate(`Bearer ${token}`), null);
});

test('an expired token is rejected; nbf in the future is rejected', () => {
  const a = auth();
  assert.equal(a.authenticate(`Bearer ${mint({ sub: 'u', tenant_id: 't', user_role: 'owner', exp: NOW - 1 })}`), null);
  assert.equal(a.authenticate(`Bearer ${mint({ sub: 'u', tenant_id: 't', user_role: 'owner', nbf: NOW + 100, exp: NOW + 3600 })}`), null);
});

test('alg:none (or any non-HS256) is refused', () => {
  const a = auth();
  const token = mint({ sub: 'u', tenant_id: 't', user_role: 'owner', exp: NOW + 3600 }, { alg: 'none' });
  assert.equal(a.authenticate(`Bearer ${token}`), null);
});

test('a token with no tenant_id claim is refused (deny-by-default, mirrors RLS)', () => {
  const a = auth();
  const token = mint({ sub: 'u', user_role: 'owner', exp: NOW + 3600 });
  assert.equal(a.authenticate(`Bearer ${token}`), null);
});

test('malformed input (no bearer, wrong segment count) returns null, never throws', () => {
  const a = auth();
  assert.equal(a.authenticate(undefined), null);
  assert.equal(a.authenticate('Bearer not-a-jwt'), null);
  assert.equal(a.authenticate('Bearer a.b'), null);
  assert.equal(a.authenticate(''), null);
});
