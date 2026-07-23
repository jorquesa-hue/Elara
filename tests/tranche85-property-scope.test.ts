// Tranche 85 — enforced per-community (property) scoping + the student_housing
// business type. A SITE operator token carries propertyIds (its communities);
// the API filters every property-scoped read to that set and 403s an explicit
// out-of-scope request. A regional/portfolio token (no propertyIds) sees all and
// may pick any community. Plus: 'student_housing' is now a valid business type.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, JwtAuthenticator, type AuthContext } from '../src/api/context.ts';
import { createHmac } from 'node:crypto';

const NOW = '2026-07-20T00:00:00Z';
// Owner: full config rights (runs setup).
const own: AuthContext = { actor: 'own', tenantId: 'mf', role: 'owner' };
// Regional manager: no property scope → sees everything, may pick any community.
const boss: AuthContext = { actor: 'boss', tenantId: 'mf', role: 'manager' };
// Site operator: locked to community A only.
const siteA: AuthContext = { actor: 'siteA', tenantId: 'mf', role: 'manager', propertyIds: ['prop-a'] };

const D = (app: App, method: string, path: string, body?: Record<string, unknown>, token = 'boss') =>
  app.dispatch({ method, path, bearer: `Bearer ${token}`, body: body ?? {} });

// Two communities, one lease each, revenue booked to each so reports have data.
function mkApp() {
  const app = new App({ authenticator: new StaticTokenAuthenticator({ own, boss, siteA }), units: [], now: () => NOW });
  D(app, 'PUT', '/config', { displayName: 'Euro MF', country: 'US' }, 'own');
  for (const p of ['a', 'b']) {
    D(app, 'POST', '/properties', { id: `prop-${p}`, code: p.toUpperCase(), name: `Community ${p.toUpperCase()}` });
    D(app, 'POST', '/units', { id: `u-${p}`, code: `${p.toUpperCase()}-1`, label: `Apt ${p}101`, propertyId: `prop-${p}` });
    D(app, 'POST', '/agreements', { id: `ag-${p}`, guestId: `Guest ${p}`, unitId: `u-${p}`, kind: 'lease', start: '2026-01-01', end: '2027-01-01', rateCents: 200000 });
    D(app, 'POST', `/agreements/ag-${p}/activate`, {});
    D(app, 'POST', '/invoices', { id: `inv-${p}`, agreementId: `ag-${p}`, issuedAt: NOW, dueAt: '2026-07-25', lines: [{ description: 'rent', account: 'revenue:room', amountCents: 200000 }] });
  }
  return app;
}

test("'student_housing' is an accepted business structure", () => {
  const app = mkApp();
  assert.equal(D(app, 'PUT', '/config', { businessStructure: 'student_housing' }, 'own').status, 200);
  assert.equal((D(app, 'GET', '/config', undefined, 'own').body as { config: { businessStructure: string } }).config.businessStructure, 'student_housing');
});

test('a site operator sees only its community leases; the regional sees both', () => {
  const app = mkApp();
  const bossList = (D(app, 'GET', '/agreements').body as { agreements: unknown[] }).agreements;
  assert.equal(bossList.length, 2);
  const siteList = (D(app, 'GET', '/agreements', undefined, 'siteA').body as { agreements: Array<{ id: string }> }).agreements;
  assert.equal(siteList.length, 1);
  assert.equal(siteList[0]!.id, 'ag-a');
});

test('a site operator cannot open a lease outside its community (404, no existence leak)', () => {
  const app = mkApp();
  assert.equal(D(app, 'GET', '/agreements/ag-a', undefined, 'siteA').status, 200); // own community
  assert.equal(D(app, 'GET', '/agreements/ag-b', undefined, 'siteA').status, 404); // other community
  assert.equal(D(app, 'GET', '/agreements/ag-b', undefined, 'boss').status, 200); // regional sees it
});

test('an explicit out-of-scope ?propertyId on a report is 403', () => {
  const app = mkApp();
  // The operator asking for its own community is fine...
  assert.equal(D(app, 'GET', '/reports/rent_roll', { propertyId: 'prop-a' }, 'siteA').status, 200);
  // ...asking for another community is refused.
  assert.equal(D(app, 'GET', '/reports/rent_roll', { propertyId: 'prop-b' }, 'siteA').status, 403);
  // The regional may scope to any community.
  assert.equal(D(app, 'GET', '/reports/rent_roll', { propertyId: 'prop-b' }, 'boss').status, 200);
});

test('the reporting summary counts only the site operator’s community', () => {
  const app = mkApp();
  const all = D(app, 'GET', '/reporting/summary', undefined, 'boss').body as { agreements: { total: number }; masterDataCounts: { units: number } };
  assert.equal(all.agreements.total, 2);
  assert.equal(all.masterDataCounts.units, 2);
  const scoped = D(app, 'GET', '/reporting/summary', undefined, 'siteA').body as { agreements: { total: number }; masterDataCounts: { units: number } };
  assert.equal(scoped.agreements.total, 1);
  assert.equal(scoped.masterDataCounts.units, 1);
});

test('/me surfaces the operator’s community scope', () => {
  const app = mkApp();
  assert.deepEqual((D(app, 'GET', '/me', undefined, 'siteA').body as { propertyIds?: string[] }).propertyIds, ['prop-a']);
  assert.equal((D(app, 'GET', '/me', undefined, 'boss').body as { propertyIds?: string[] }).propertyIds, undefined);
});

test('JwtAuthenticator reads property_ids as an array or a comma-separated string (top-level or app_metadata)', () => {
  const secret = 'test-secret';
  const auth = new JwtAuthenticator({ secret, now: () => 1_800_000_000 });
  const mint = (claims: Record<string, unknown>) => {
    const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const h = b({ alg: 'HS256', typ: 'JWT' });
    const p = b({ tenant_id: 'mf', user_role: 'manager', sub: 'u', ...claims });
    return `${h}.${p}.${createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url')}`;
  };
  assert.deepEqual(auth.authenticate(`Bearer ${mint({ property_ids: ['prop-a', 'prop-b'] })}`)?.propertyIds, ['prop-a', 'prop-b']);
  assert.deepEqual(auth.authenticate(`Bearer ${mint({ property_ids: 'prop-a, prop-c' })}`)?.propertyIds, ['prop-a', 'prop-c']);
  assert.deepEqual(auth.authenticate(`Bearer ${mint({ app_metadata: { property_ids: ['prop-z'] } })}`)?.propertyIds, ['prop-z']);
  assert.equal(auth.authenticate(`Bearer ${mint({})}`)?.propertyIds, undefined);
});
