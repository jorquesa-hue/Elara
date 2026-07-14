// Tranche 82 — Phase 7B: owner/investor read portal. An owner token (carrying
// entityId) gets a read-only view of THEIR legal entity's communities (NOI from
// the ledger) and the distributions paid to them. Strictly entity-scoped: an
// owner sees only their own entity, never another owner's or the operator
// surface. 10 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';

const NOW = '2026-07-13T00:00:00Z';
const own: AuthContext = { actor: 'own', tenantId: 'mf', role: 'owner' };
const acc: AuthContext = { actor: 'acc', tenantId: 'mf', role: 'accountant' };
const ownerA: AuthContext = { actor: 'oa', tenantId: 'mf', role: 'read_only', entityId: 'ent-a' };
const ownerB: AuthContext = { actor: 'ob', tenantId: 'mf', role: 'read_only', entityId: 'ent-b' };

const D = (app: App, method: string, path: string, body?: Record<string, unknown>, token = 'own') =>
  app.dispatch({ method, path, bearer: `Bearer ${token}`, body: body ?? {} });

function mkApp() {
  const app = new App({ authenticator: new StaticTokenAuthenticator({ own, acc, oa: ownerA, ob: ownerB }), units: [], now: () => NOW });
  D(app, 'PUT', '/config', { displayName: 'Greyline', country: 'US' });
  D(app, 'POST', '/legal-entities', { id: 'ent-a', name: 'Northgate SPE LLC', role: 'spe' });
  D(app, 'POST', '/legal-entities', { id: 'ent-b', name: 'Southgate SPE LLC', role: 'spe' });
  D(app, 'POST', '/properties', { id: 'prop-a', code: 'NG', name: 'Northgate', entityId: 'ent-a' });
  D(app, 'POST', '/properties', { id: 'prop-b', code: 'SG', name: 'Southgate', entityId: 'ent-b' });
  D(app, 'POST', '/units', { id: 'u-a', code: 'A-1', label: 'Apt 101', propertyId: 'prop-a' });
  D(app, 'POST', '/agreements', { id: 'ag-a', guestId: 'Bea Lima', unitId: 'u-a', kind: 'lease', start: '2026-01-01', end: '2027-01-01', rateCents: 300000 });
  D(app, 'POST', '/agreements/ag-a/activate', {});
  // Revenue on Northgate -> NOI for ent-a.
  D(app, 'POST', '/invoices', { id: 'inv-a', agreementId: 'ag-a', issuedAt: NOW, dueAt: '2026-07-20', lines: [{ description: 'rent', account: 'revenue:room', amountCents: 300000 }] });
  // A distribution paid to ent-a on Northgate.
  D(app, 'POST', '/distributions', { id: 'dist-a', entityId: 'ent-a', propertyId: 'prop-a', amountCents: 100000, memo: 'Q2 draw' }, 'acc');
  return app;
}

type Home = {
  profile: { entityId: string; name: string; role: string };
  currency: string;
  properties: Array<{ id: string; name: string; noiCents: number; distributedCents: number }>;
  totalNoiCents: number; totalDistributedCents: number;
  distributions: Array<{ id: string; propertyName: string; amountCents: number }>;
};

test('an owner sees their entity, communities, NOI and distributions', () => {
  const app = mkApp();
  const home = D(app, 'GET', '/owner/home', undefined, 'oa').body as Home;
  assert.equal(home.profile.name, 'Northgate SPE LLC');
  assert.equal(home.properties.length, 1);
  assert.equal(home.properties[0]!.name, 'Northgate');
  assert.equal(home.properties[0]!.noiCents, 300000); // the rent revenue posts NOI
  assert.equal(home.properties[0]!.distributedCents, 100000);
  assert.equal(home.totalNoiCents, 300000);
  assert.equal(home.totalDistributedCents, 100000);
  assert.equal(home.distributions.length, 1);
  assert.equal(home.distributions[0]!.amountCents, 100000);
});

test('NOI reflects expenses as well as revenue', () => {
  const app = mkApp();
  // A vendor bill attributed to Northgate reduces NOI.
  D(app, 'POST', '/parties', { id: 'v-1', kind: 'organization', displayName: 'Acme Repairs' });
  D(app, 'POST', '/bills', { id: 'bill-a', payeeId: 'v-1', propertyId: 'prop-a', dueAt: '2026-07-20', lines: [{ description: 'repair', account: 'expense:repairs', amountCents: 50000 }] });
  const home = D(app, 'GET', '/owner/home', undefined, 'oa').body as Home;
  assert.equal(home.properties[0]!.noiCents, 250000); // 300000 revenue - 50000 expense
});

test('a second owner sees only their own entity (no cross-owner leak)', () => {
  const app = mkApp();
  const home = D(app, 'GET', '/owner/home', undefined, 'ob').body as Home;
  assert.equal(home.profile.name, 'Southgate SPE LLC');
  assert.equal(home.properties.length, 1);
  assert.equal(home.properties[0]!.name, 'Southgate');
  assert.equal(home.properties[0]!.noiCents, 0); // no activity on Southgate
  assert.equal(home.totalDistributedCents, 0); // the ent-a distribution is not visible
  assert.equal(home.distributions.length, 0);
});

test('an operator token (no entityId) is 403 on the owner portal', () => {
  const app = mkApp();
  assert.equal(D(app, 'GET', '/owner/home', undefined, 'own').status, 403);
});

test('an owner token for an unknown entity is 404', () => {
  const ghost: AuthContext = { actor: 'g', tenantId: 'mf', role: 'read_only', entityId: 'ghost' };
  const app2 = new App({ authenticator: new StaticTokenAuthenticator({ g: ghost }), now: () => NOW });
  app2.dispatch({ method: 'PUT', path: '/config', bearer: 'Bearer g', body: { displayName: 'X', country: 'US' } });
  assert.equal(app2.dispatch({ method: 'GET', path: '/owner/home', bearer: 'Bearer g', body: {} }).status, 404);
});

test('/me surfaces the owner entityId', () => {
  const app = mkApp();
  const me = D(app, 'GET', '/me', undefined, 'oa').body as { entityId?: string; partyId?: string };
  assert.equal(me.entityId, 'ent-a');
  assert.equal(me.partyId, undefined);
});

test('the owner portal is read-only — recording a distribution is 403 for an owner token', () => {
  const app = mkApp();
  // An owner (read_only + entityId) has neither distribution.record nor a write surface.
  assert.equal(D(app, 'POST', '/distributions', { id: 'd-x', entityId: 'ent-a', amountCents: 1000 }, 'oa').status, 403);
});

test('NOI ignores non-P&L accounts (the AR line from the invoice is excluded)', () => {
  const app = mkApp();
  // The invoice posts DR assets:accounts_receivable / CR revenue:room. Only the
  // revenue leg counts toward NOI — the AR asset leg must not.
  const home = D(app, 'GET', '/owner/home', undefined, 'oa').body as Home;
  assert.equal(home.properties[0]!.noiCents, 300000); // exactly the revenue, not doubled by AR
});

test('a distribution to the whole portfolio (no property) shows under Portfolio', () => {
  const app = mkApp();
  D(app, 'POST', '/distributions', { id: 'dist-port', entityId: 'ent-a', amountCents: 40000 }, 'acc');
  const home = D(app, 'GET', '/owner/home', undefined, 'oa').body as Home;
  assert.equal(home.totalDistributedCents, 140000); // 100000 property + 40000 portfolio
  assert.ok(home.distributions.some((d) => d.propertyName === 'Portfolio' && d.amountCents === 40000));
});

test('the entityId claim round-trips through the JWT authenticator', async () => {
  const { JwtAuthenticator } = await import('../src/api/context.ts');
  const crypto = await import('node:crypto');
  const secret = 'test-secret';
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const payload = b64({ tenant_id: 'mf', user_role: 'read_only', entity_id: 'ent-a', sub: 'owner@x.com' });
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  const auth = new JwtAuthenticator({ secret });
  const ctx = auth.authenticate(`Bearer ${header}.${payload}.${sig}`);
  assert.equal(ctx?.entityId, 'ent-a');
  assert.equal(ctx?.partyId, undefined);
});
