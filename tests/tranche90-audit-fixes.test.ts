// Tranche 90 — two defects surfaced by the gap audit:
//  (1) community-locked operators (ctx.propertyIds) must not read other
//      communities' bills or property budgets via the new financial endpoints;
//  (2) the report window default is 30 days, so the portal "All time" preset —
//      which sends from=1970-01-01 — must actually widen the window (regression
//      pin: an out-of-window record shows under all-time but not under a 30-day).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';

const NOW = '2026-07-24T00:00:00Z';
const own: AuthContext = { actor: 'own', tenantId: 't', role: 'owner' };
// A site operator locked to community A only.
const locked: AuthContext = { actor: 'op', tenantId: 't', role: 'manager', propertyIds: ['prop-a'] };
const D = (app: App, who: string, method: string, path: string, body?: Record<string, unknown>) =>
  app.dispatch({ method, path, bearer: 'Bearer ' + who, body: body ?? {} });

function mkApp() {
  const app = new App({ authenticator: new StaticTokenAuthenticator({ own, op: locked }), units: [], now: () => NOW });
  D(app, 'own', 'PUT', '/config', { displayName: 'M', country: 'GB' });
  D(app, 'own', 'POST', '/properties', { id: 'prop-a', code: 'A', name: 'Community A' });
  D(app, 'own', 'POST', '/properties', { id: 'prop-b', code: 'B', name: 'Community B' });
  D(app, 'own', 'POST', '/parties', { id: 'v1', kind: 'organization', displayName: 'Vendor' });
  // A bill in each community.
  D(app, 'own', 'POST', '/bills', { id: 'bill-a', payeeId: 'v1', propertyId: 'prop-a', dueAt: '2026-08-01', lines: [{ description: 'A repair', account: 'expense:repairs', amountCents: 10000 }] });
  D(app, 'own', 'POST', '/bills', { id: 'bill-b', payeeId: 'v1', propertyId: 'prop-b', dueAt: '2026-08-01', lines: [{ description: 'B repair', account: 'expense:repairs', amountCents: 20000 }] });
  // A budget in each community.
  D(app, 'own', 'POST', '/property-budgets', { id: 'pb-a', propertyId: 'prop-a', periodStart: '2026-01-01', periodEnd: '2026-12-31', lines: [{ category: 'expense', label: 'Repairs', amountCents: 100000 }] });
  D(app, 'own', 'POST', '/property-budgets', { id: 'pb-b', propertyId: 'prop-b', periodStart: '2026-01-01', periodEnd: '2026-12-31', lines: [{ category: 'expense', label: 'Repairs', amountCents: 200000 }] });
  return app;
}

test('a community-locked operator sees only its own community bills', () => {
  const app = mkApp();
  const all = (D(app, 'own', 'GET', '/bills').body as { bills: Array<{ id: string }> }).bills;
  assert.equal(all.length, 2, 'owner sees both');
  const mine = (D(app, 'op', 'GET', '/bills').body as { bills: Array<{ id: string }> }).bills;
  assert.deepEqual(mine.map((b) => b.id), ['bill-a'], 'locked operator sees only community A');
  assert.equal(D(app, 'op', 'GET', '/bills/bill-b').status, 404, 'cannot read community B bill by id');
  assert.equal(D(app, 'op', 'GET', '/bills/bill-a').status, 200, 'can read its own');
});

test('a community-locked operator sees only its own community budgets', () => {
  const app = mkApp();
  const mine = (D(app, 'op', 'GET', '/property-budgets').body as { budgets: Array<{ id: string }> }).budgets;
  assert.deepEqual(mine.map((b) => b.id), ['pb-a']);
  assert.equal(D(app, 'op', 'GET', '/property-budgets/pb-b').status, 404, 'cannot read community B budget by id');
  assert.equal(D(app, 'op', 'GET', '/property-budgets/pb-a').status, 200);
  // Requesting an out-of-scope community explicitly is a 403.
  assert.equal(D(app, 'op', 'GET', '/property-budgets', { propertyId: 'prop-b' }).status, 403);
});

test('the report window default is 30 days; an explicit all-time (from=1970) widens it', () => {
  const app = mkApp();
  const win = (body?: Record<string, unknown>) =>
    (D(app, 'own', 'GET', '/reports/income_statement', body).body as { report: { window: { from: string; to: string } } }).report.window;
  // No dates → the server's default 30-day window (the portal used to send this
  // for "All time", which is the bug).
  const def = win({});
  assert.ok(def.from > '2026-06-01', `default window starts ~30 days back, got ${def.from}`);
  // The portal's "All time" preset now sends from=1970-01-01 → the window widens.
  const all = win({ from: '1970-01-01', to: '2026-07-25' });
  assert.equal(all.from, '1970-01-01', 'all-time is honored, not silently 30 days');
});
