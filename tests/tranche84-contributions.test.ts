// Tranche 84 — Phase 7D: owner capital contributions + capital account. The
// money-IN counterpart to distributions: an owner puts capital INTO an entity
// (DR assets:cash / CR equity:contributions). RBAC-only (cash in is not a payout
// risk). Together with distributions this completes the capital account. 11 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';
import { projectWorld } from '../src/persistence/project.ts';

const NOW = '2026-07-13T00:00:00Z';
const own: AuthContext = { actor: 'own', tenantId: 'mf', role: 'owner' };
const acc: AuthContext = { actor: 'acc', tenantId: 'mf', role: 'accountant' };
const fd: AuthContext = { actor: 'fd', tenantId: 'mf', role: 'front_desk' };
const ro: AuthContext = { actor: 'r', tenantId: 'mf', role: 'read_only' };
const ownerA: AuthContext = { actor: 'oa', tenantId: 'mf', role: 'read_only', entityId: 'ent-a' };

const D = (app: App, method: string, path: string, body?: Record<string, unknown>, token = 'own') =>
  app.dispatch({ method, path, bearer: `Bearer ${token}`, body: body ?? {} });

function mkApp() {
  const app = new App({ authenticator: new StaticTokenAuthenticator({ own, acc, fd, r: ro, oa: ownerA }), units: [], now: () => NOW });
  D(app, 'PUT', '/config', { displayName: 'Greyline', country: 'US' });
  D(app, 'POST', '/legal-entities', { id: 'ent-a', name: 'Northgate SPE LLC', role: 'spe' });
  D(app, 'POST', '/properties', { id: 'prop-a', code: 'NG', name: 'Northgate', entityId: 'ent-a' });
  return app;
}
function contribute(app: App, over: Record<string, unknown> = {}, token = 'acc') {
  return D(app, 'POST', '/contributions', { id: 'c-1', entityId: 'ent-a', propertyId: 'prop-a', amountCents: 5000000, memo: 'seed capital', ...over }, token);
}
const balanced = (app: App) => (D(app, 'GET', '/ledger/trial-balance').body as { balanced: boolean }).balanced;

test('recording a contribution posts a balanced DR cash / CR equity:contributions entry', () => {
  const app = mkApp();
  const r = contribute(app);
  assert.equal(r.status, 201);
  const c = r.body as { amountCents: number; entityName: string; propertyName: string };
  assert.equal(c.amountCents, 5000000);
  assert.equal(c.entityName, 'Northgate SPE LLC');
  assert.equal(balanced(app), true);
  const rep = D(app, 'GET', '/reports/general_ledger').body as { report: { rows: Array<{ account: string }> } };
  assert.ok(rep.report.rows.find((x) => x.account === 'equity:contributions'), 'the contributions equity account exists');
});

test('a large contribution is NOT policy-gated (money in is not a payout risk)', () => {
  const app = mkApp();
  // Far above the R$5k distribution threshold — still auto-records (no escalation).
  assert.equal(contribute(app, { id: 'c-big', amountCents: 100000000 }).status, 201);
});

test('unknown entity 404; unknown property 404; non-positive amount 409', () => {
  const app = mkApp();
  assert.equal(contribute(app, { id: 'c-x', entityId: 'ghost' }).status, 404);
  assert.equal(contribute(app, { id: 'c-y', propertyId: 'nope' }).status, 404);
  assert.equal(contribute(app, { id: 'c-z', amountCents: 0 }).status, 409);
});

test('capital.record is finance-only: read_only reads, front-desk 403, accountant records', () => {
  const app = mkApp(); contribute(app);
  assert.equal(D(app, 'GET', '/contributions', undefined, 'r').status, 200);
  assert.equal(contribute(app, { id: 'c-ro' }, 'r').status, 403);
  assert.equal(contribute(app, { id: 'c-fd' }, 'fd').status, 403); // front_desk is OPS, no capital.record
  assert.equal(contribute(app, { id: 'c-acc' }, 'acc').status, 201);
});

test('the capital account nets contributions against distributions', () => {
  const app = mkApp();
  contribute(app, { id: 'c-1', amountCents: 5000000 }); // 50k in
  D(app, 'POST', '/distributions', { id: 'd-1', entityId: 'ent-a', amountCents: 300000 }, 'acc'); // 3k out (within distributable? NOI 0 -> escalates!)
  // The distribution above escalates (NOI 0), so it does NOT reduce the account.
  const ca = D(app, 'GET', '/contributions/capital-account', { entityId: 'ent-a' }).body as { contributionsCents: number; distributionsCents: number; netCapitalCents: number };
  assert.equal(ca.contributionsCents, 5000000);
  assert.equal(ca.distributionsCents, 0); // the draw parked, not recorded
  assert.equal(ca.netCapitalCents, 5000000);
});

test('a recorded distribution reduces net capital', () => {
  const app = mkApp();
  contribute(app, { id: 'c-1', amountCents: 5000000 });
  // Approve a distribution so it records (NOI 0 -> escalates -> approve).
  const esc = D(app, 'POST', '/distributions', { id: 'd-1', entityId: 'ent-a', amountCents: 300000 }, 'acc');
  D(app, 'POST', `/exceptions/${(esc.body as { exceptionId: string }).exceptionId}/approve`, {}, 'own');
  const ca = D(app, 'GET', '/contributions/capital-account', { entityId: 'ent-a' }).body as { netCapitalCents: number };
  assert.equal(ca.netCapitalCents, 4700000); // 5000000 - 300000
});

test('GET list and GET :id return the contribution with owner labels', () => {
  const app = mkApp(); contribute(app);
  assert.equal((D(app, 'GET', '/contributions').body as { contributions: unknown[] }).contributions.length, 1);
  assert.equal((D(app, 'GET', '/contributions/c-1').body as { entityName: string }).entityName, 'Northgate SPE LLC');
});

test('contributions are tenant-scoped', () => {
  const app = mkApp(); contribute(app);
  const o2: AuthContext = { actor: 'o2', tenantId: 'other', role: 'owner' };
  const app2 = new App({ authenticator: new StaticTokenAuthenticator({ o2 }), now: () => NOW });
  app2.dispatch({ method: 'PUT', path: '/config', bearer: 'Bearer o2', body: { displayName: 'O', country: 'US' } });
  assert.equal((app2.dispatch({ method: 'GET', path: '/contributions', bearer: 'Bearer o2', body: {} }).body as { contributions: unknown[] }).contributions.length, 0);
  assert.equal(app2.dispatch({ method: 'GET', path: '/contributions/c-1', bearer: 'Bearer o2', body: {} }).status, 404);
});

test('the owner home surfaces the capital account', () => {
  const app = mkApp(); contribute(app, { id: 'c-1', amountCents: 5000000 });
  const home = D(app, 'GET', '/owner/home', undefined, 'oa').body as { capitalAccount: { contributionsCents: number; netCapitalCents: number } };
  assert.equal(home.capitalAccount.contributionsCents, 5000000);
  assert.equal(home.capitalAccount.netCapitalCents, 5000000);
});

test('the capital-account report nets contributions vs distributions per entity', () => {
  const app = mkApp();
  contribute(app, { id: 'c-1', amountCents: 5000000 });
  const rep = D(app, 'GET', '/reports/capital_account').body as { report: { rows: Array<{ entity: string; contributed: number; net: number }>; kpis: Array<{ label: string; value: number }> } };
  assert.equal(rep.report.rows[0]!.entity, 'Northgate SPE LLC');
  assert.equal(rep.report.rows[0]!.contributed, 5000000);
  assert.equal(rep.report.rows[0]!.net, 5000000);
  assert.equal(rep.report.kpis.find((k) => k.label === 'Total contributed')!.value, 5000000);
});

test('a contribution projects to SQL and survives snapshot → rehydrate', () => {
  const app = mkApp(); contribute(app);
  assert.ok(projectWorld(app.snapshotWorld('mf')).find((x) => x.text.startsWith('insert into contribution ')));
  const b = new App({ authenticator: new StaticTokenAuthenticator({ own }), now: () => NOW });
  b.rehydrate(app.snapshotWorld('mf'));
  const c = (b.snapshotWorld('mf').contributions ?? []).find((x) => x.id === 'c-1')!;
  assert.equal(c.amountCents, 5000000);
  assert.equal(c.entityId, 'ent-a');
});
