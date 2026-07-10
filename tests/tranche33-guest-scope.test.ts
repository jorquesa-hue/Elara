// Tranche 33 — guest/resident tokens are party-scoped. A token carrying a
// partyId (a guest, not an operator) may read ONLY the agreements its party is
// linked to — closing the horizontal-read gap from the security review. 5 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';

const T = '2026-07-01T00:00:00Z';
const bearer = (t: string) => `Bearer ${t}`;
const D = (app: App, method: string, path: string, token: string, body?: Record<string, unknown>) =>
  app.dispatch({ method, path, bearer: bearer(token), body });

// owner operates; guest is a party-scoped token for party p-guest.
function makeApp() {
  const owner: AuthContext = { actor: 'ana', tenantId: 't1', role: 'owner' };
  const guest: AuthContext = { actor: 'p-guest', tenantId: 't1', role: 'guest', partyId: 'p-guest' };
  const auth = new StaticTokenAuthenticator({ own: owner, guest });
  const app = new App({ authenticator: auth, units: [{ id: 'u-1', tenantId: 't1' }, { id: 'u-2', tenantId: 't1' }], now: () => T });
  return app;
}

function setup(app: App) {
  // Two agreements; the guest's party is linked (as resident) to ag-1 only.
  D(app, 'POST', '/agreements', 'own', { id: 'ag-1', guestId: 'g-1', unitId: 'u-1', kind: 'nightly', start: '2026-07-01', end: '2026-07-10', rateCents: 20000 });
  D(app, 'POST', '/agreements', 'own', { id: 'ag-2', guestId: 'g-2', unitId: 'u-2', kind: 'nightly', start: '2026-07-01', end: '2026-07-10', rateCents: 20000 });
  D(app, 'POST', '/parties', 'own', { id: 'p-guest', kind: 'person', displayName: 'Guest One' });
  D(app, 'POST', '/agreements/ag-1/parties', 'own', { partyId: 'p-guest', role: 'resident' });
  // An invoice on each agreement.
  D(app, 'POST', '/invoices', 'own', { id: 'inv-1', agreementId: 'ag-1', dueAt: '2026-07-09', lines: [{ description: 'stay', account: 'revenue:room', amountCents: 20000 }] });
  D(app, 'POST', '/invoices', 'own', { id: 'inv-2', agreementId: 'ag-2', dueAt: '2026-07-09', lines: [{ description: 'stay', account: 'revenue:room', amountCents: 20000 }] });
}

test('a guest reads its OWN agreement', () => {
  const app = makeApp();
  setup(app);
  assert.equal(D(app, 'GET', '/agreements/ag-1', 'guest').status, 200);
  assert.equal(D(app, 'GET', '/agreements/ag-1/billing', 'guest').status, 200);
});

test('a guest gets 404 (not 403) on an agreement it is NOT a party to — existence not leaked', () => {
  const app = makeApp();
  setup(app);
  assert.equal(D(app, 'GET', '/agreements/ag-2', 'guest').status, 404);
  assert.equal(D(app, 'GET', '/agreements/ag-2/billing', 'guest').status, 404);
});

test('a guest CANNOT read another agreement’s invoice by id', () => {
  const app = makeApp();
  setup(app);
  assert.equal(D(app, 'GET', '/invoices/inv-1', 'guest').status, 200); // own
  assert.equal(D(app, 'GET', '/invoices/inv-2', 'guest').status, 404); // not its agreement
});

test('the agreement LIST shows a guest only its own agreements', () => {
  const app = makeApp();
  setup(app);
  const list = D(app, 'GET', '/agreements', 'guest');
  assert.equal(list.status, 200);
  const ids = (list.body as { agreements: Array<{ id: string }> }).agreements.map((a) => a.id);
  assert.deepEqual(ids, ['ag-1']);
});

test('an operator token (no partyId) still sees every agreement in the tenant', () => {
  const app = makeApp();
  setup(app);
  const list = D(app, 'GET', '/agreements', 'own');
  const ids = (list.body as { agreements: Array<{ id: string }> }).agreements.map((a) => a.id).sort();
  assert.deepEqual(ids, ['ag-1', 'ag-2']);
  assert.equal(D(app, 'GET', '/agreements/ag-2', 'own').status, 200);
});
