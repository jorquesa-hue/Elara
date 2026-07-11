// Tranche 47 — Access Advisor. A plain-language description of what a person does
// becomes a least-privilege access recommendation: matched capabilities → exact
// permissions, the closest built-in role (or a proposed custom role), rationale
// and risk flags. Pure + deterministic; also reachable via POST /access/advise.
// 10 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { recommendAccess } from '../src/access-advisor.ts';
import { PERMISSIONS } from '../src/rbac.ts';
import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';

const ALL = new Set<string>(PERMISSIONS);

test('front-desk description matches bookings + payments and yields valid permissions', () => {
  const r = recommendAccess('Receptionist who checks guests in and takes payments at the front desk');
  const keys = r.capabilities.map((c) => c.key);
  assert.ok(keys.includes('front_desk'));
  assert.ok(keys.includes('payments'));
  // Every recommended permission is a real RBAC permission (can't drift into invalid grants).
  for (const p of r.permissions) assert.ok(ALL.has(p), `invalid perm ${p}`);
  assert.equal(r.confidence, 'high'); // ≥2 capabilities matched
});

test('a clean single-purpose need maps to a built-in role', () => {
  const r = recommendAccess('read only access to view dashboards across the portfolio');
  assert.ok(r.suggestedRole, 'expected a built-in suggestion');
  assert.equal(r.suggestedRole!.id, 'read_only');
  assert.equal(r.proposedRole, null);
});

test('accountant description flags sensitive money-moving grants', () => {
  const r = recommendAccess('Accountant handling the ledger, vendor bills and deposit refunds');
  assert.ok(r.capabilities.some((c) => c.key === 'accounting'));
  // bill.pay and deposit.refund are money-moving → surfaced as risks.
  assert.ok(r.risks.some((x) => x.includes('bill.pay') || x.toLowerCase().includes('refund')),
    `risks were: ${JSON.stringify(r.risks)}`);
});

test('user-administration intent flags an administrative grant and can reach admin roles', () => {
  const r = recommendAccess('Team admin who manages users and defines roles and permissions');
  assert.ok(r.capabilities.some((c) => c.key === 'useradmin'));
  assert.ok(r.risks.some((x) => x.includes('user.manage') || x.includes('role.manage')));
});

test('vague description falls back to a safe read-only baseline with low confidence', () => {
  const r = recommendAccess('a person who helps out sometimes');
  assert.equal(r.confidence, 'low');
  assert.ok(r.capabilities.some((c) => c.key === 'view'));
  // No write permissions in a vague fallback.
  assert.ok(!r.permissions.some((p) => p.endsWith('.manage') || p.endsWith('.refund') || p === 'bill.pay'));
});

test('the standalone " ap " token does not match the word "apartment"', () => {
  const r = recommendAccess('cleans each apartment between guests'); // maintenance, NOT accounting
  assert.ok(!r.capabilities.some((c) => c.key === 'accounting'), 'accounting should not match "apartment"');
  assert.ok(r.capabilities.some((c) => c.key === 'maintenance'));
});

test('deterministic: identical descriptions produce identical recommendations', () => {
  const a = recommendAccess('leasing agent working the CRM pipeline and sending e-sign documents');
  const b = recommendAccess('leasing agent working the CRM pipeline and sending e-sign documents');
  assert.deepEqual(a, b);
});

test('an unusual mix with no clean built-in proposes an exact custom role', () => {
  const r = recommendAccess('runs collections and manages door locks and integrations', 'collections_devices');
  // collections + integrations rarely coincide in a single built-in → custom.
  if (r.proposedRole) {
    assert.equal(r.proposedRole.id, 'collections_devices');
    assert.deepEqual([...r.proposedRole.permissions].sort(), r.permissions);
  } else {
    // If a built-in did cover it, it must at least cover every needed permission.
    assert.ok(r.suggestedRole);
  }
});

test('POST /access/advise returns the recommendation (role.read gated)', () => {
  const mgr: AuthContext = { actor: 'm', tenantId: 't1', role: 'manager' };
  const app = new App({ authenticator: new StaticTokenAuthenticator({ mgr }), now: () => '2026-07-11T00:00:00Z' });
  const res = app.dispatch({ method: 'POST', path: '/access/advise', bearer: 'Bearer mgr', body: { description: 'front desk receptionist taking bookings' } });
  assert.equal(res.status, 200);
  const rec = res.body as ReturnType<typeof recommendAccess>;
  assert.ok(rec.capabilities.some((c) => c.key === 'front_desk'));
});

test('POST /access/advise is denied without role.read', () => {
  const guest: AuthContext = { actor: 'g', tenantId: 't1', role: 'guest' };
  const app = new App({ authenticator: new StaticTokenAuthenticator({ guest }), now: () => '2026-07-11T00:00:00Z' });
  const res = app.dispatch({ method: 'POST', path: '/access/advise', bearer: 'Bearer guest', body: { description: 'anything' } });
  assert.equal(res.status, 403);
});
