// Tranche 46 — asymmetric JWT verification. Supabase's new JWT SIGNING KEYS sign
// access tokens with RS256/ES256 (not the legacy HS256 shared secret); GoTrue
// issued a perfectly valid token but the HS256-only authenticator rejected it,
// so a real login bounced with "session expired". The authenticator now verifies
// RS256/ES256 against the project's JWKS public keys too, keeping HS256. 8 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHmac, createSign, sign as cryptoSign, type KeyObject } from 'node:crypto';

import { JwtAuthenticator, type Jwk } from '../src/api/context.ts';

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const NOW = 1_800_000_000; // fixed clock

function publicJwk(key: KeyObject, kid: string, alg: string): Jwk {
  return { ...(key.export({ format: 'jwk' }) as Record<string, unknown>), kid, alg, use: 'sig' };
}

/** Assemble a signed JWT. `sign(signingInput)` returns the raw signature bytes. */
function makeToken(header: Record<string, unknown>, payload: Record<string, unknown>, sign: (input: string) => Buffer): string {
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify({ exp: NOW + 3600, ...payload }));
  const sig = b64url(sign(`${h}.${p}`));
  return `${h}.${p}.${sig}`;
}

const CLAIMS = { app_metadata: { tenant_id: 't-jq', user_role: 'owner' }, sub: 'user-1' };

// ---- ES256 (elliptic curve — Supabase's default asymmetric alg) -----------

test('ES256 token signed by the project key authenticates against the JWKS', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const auth = new JwtAuthenticator({ jwks: [publicJwk(publicKey, 'k-es', 'ES256')], now: () => NOW });
  const token = makeToken({ alg: 'ES256', typ: 'JWT', kid: 'k-es' }, CLAIMS,
    (input) => cryptoSign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' }));
  const ctx = auth.authenticate(`Bearer ${token}`);
  assert.ok(ctx, 'token accepted');
  assert.equal(ctx!.tenantId, 't-jq');
  assert.equal(ctx!.role, 'owner');
});

test('a tampered ES256 payload is rejected', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const auth = new JwtAuthenticator({ jwks: [publicJwk(publicKey, 'k-es', 'ES256')], now: () => NOW });
  const token = makeToken({ alg: 'ES256', typ: 'JWT', kid: 'k-es' }, CLAIMS,
    (input) => cryptoSign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' }));
  const [h, p, s] = token.split('.');
  const forged = b64url(JSON.stringify({ exp: NOW + 3600, app_metadata: { tenant_id: 't-EVIL', user_role: 'owner' } }));
  assert.equal(auth.authenticate(`Bearer ${h}.${forged}.${s}`), null);
});

test('an ES256 token whose kid is not in the JWKS is rejected', () => {
  const a = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const b = generateKeyPairSync('ec', { namedCurve: 'P-256' }); // a DIFFERENT key
  const auth = new JwtAuthenticator({ jwks: [publicJwk(a.publicKey, 'k-a', 'ES256')], now: () => NOW });
  const token = makeToken({ alg: 'ES256', typ: 'JWT', kid: 'k-b' }, CLAIMS,
    (input) => cryptoSign('sha256', Buffer.from(input), { key: b.privateKey, dsaEncoding: 'ieee-p1363' }));
  assert.equal(auth.authenticate(`Bearer ${token}`), null);
});

// ---- RS256 (RSA) ----------------------------------------------------------

test('RS256 token authenticates against the JWKS', () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const auth = new JwtAuthenticator({ jwks: [publicJwk(publicKey, 'k-rs', 'RS256')], now: () => NOW });
  const token = makeToken({ alg: 'RS256', typ: 'JWT', kid: 'k-rs' }, CLAIMS,
    (input) => createSign('RSA-SHA256').update(input).sign(privateKey));
  const ctx = auth.authenticate(`Bearer ${token}`);
  assert.ok(ctx);
  assert.equal(ctx!.tenantId, 't-jq');
});

// ---- both modes coexist + safety ------------------------------------------

test('the SAME authenticator accepts an HS256 token AND an ES256 token', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const auth = new JwtAuthenticator({ secret: 'legacy-shared-secret', jwks: [publicJwk(publicKey, 'k-es', 'ES256')], now: () => NOW });

  const hs = makeToken({ alg: 'HS256', typ: 'JWT' }, CLAIMS,
    (input) => createHmac('sha256', 'legacy-shared-secret').update(input).digest());
  const es = makeToken({ alg: 'ES256', typ: 'JWT', kid: 'k-es' }, CLAIMS,
    (input) => cryptoSign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' }));

  assert.equal(auth.authenticate(`Bearer ${hs}`)?.tenantId, 't-jq');
  assert.equal(auth.authenticate(`Bearer ${es}`)?.tenantId, 't-jq');
});

test('alg:none is refused even when the signature segment is empty', () => {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const auth = new JwtAuthenticator({ secret: 's', jwks: [publicJwk(publicKey, 'k', 'ES256')], now: () => NOW });
  const h = b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const p = b64url(JSON.stringify({ exp: NOW + 3600, app_metadata: { tenant_id: 't', user_role: 'owner' } }));
  assert.equal(auth.authenticate(`Bearer ${h}.${p}.`), null);
});

test('an expired ES256 token is rejected', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const auth = new JwtAuthenticator({ jwks: [publicJwk(publicKey, 'k-es', 'ES256')], now: () => NOW });
  const token = makeToken({ alg: 'ES256', typ: 'JWT', kid: 'k-es' }, { ...CLAIMS, exp: NOW - 10 },
    (input) => cryptoSign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' }));
  assert.equal(auth.authenticate(`Bearer ${token}`), null);
});

test('setJwks swaps the keys (a rotated key verifies after refresh, before it does not)', () => {
  const oldK = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const newK = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const auth = new JwtAuthenticator({ jwks: [publicJwk(oldK.publicKey, 'k-old', 'ES256')], now: () => NOW });
  const token = makeToken({ alg: 'ES256', typ: 'JWT', kid: 'k-new' }, CLAIMS,
    (input) => cryptoSign('sha256', Buffer.from(input), { key: newK.privateKey, dsaEncoding: 'ieee-p1363' }));
  assert.equal(auth.authenticate(`Bearer ${token}`), null); // key not yet known
  auth.setJwks([publicJwk(newK.publicKey, 'k-new', 'ES256')]);
  assert.ok(auth.authenticate(`Bearer ${token}`)); // after refresh, accepted
});

// A construction guard: at least one verification method is required.
test('constructing with neither secret nor jwks throws', () => {
  assert.throws(() => new JwtAuthenticator({}), /secret or a JWKS/);
});
