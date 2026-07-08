// Tranche 15 — Phase 2 module 1: maintenance / work orders (#3) through the
// Public API. A work order is raised on a space, assigned to a vendor party,
// worked, and closed; its cost reuses accounts payable. Auth → RBAC → policy
// gate every mutation. 9 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';

const T = '2026-07-01T00:00:00Z';
const bearer = (t: string) => `Bearer ${t}`;

function makeApp() {
  const owner: AuthContext = { actor: 'ana', tenantId: 't1', role: 'owner' };
  const agent: AuthContext = { actor: 'bot', tenantId: 't1', role: 'agent' };
  const reader: AuthContext = { actor: 'aud', tenantId: 't1', role: 'read_only' };
  const other: AuthContext = { actor: 'sp', tenantId: 't2', role: 'owner' };
  const auth = new StaticTokenAuthenticator({ own: owner, bot: agent, ro: reader, sp: other });
  return new App({ authenticator: auth, now: () => T });
}
const D = (app: App, method: string, path: string, token: string, body?: Record<string, unknown>) =>
  app.dispatch({ method, path, bearer: bearer(token), body });

function seed(app: App) {
  D(app, 'POST', '/spaces', 'own', { id: 's-u', type: 'unit', code: 'U1', label: 'Unit 1', leasable: true });
  D(app, 'POST', '/parties', 'own', { id: 'v-1', kind: 'organization', displayName: 'Acme Plumbing' });
}

test('work order lifecycle: open → assign → start → complete', () => {
  const app = makeApp();
  seed(app);
  const open = D(app, 'POST', '/work-orders', 'own', { id: 'wo-1', title: 'Leaky faucet', spaceId: 's-u', priority: 'high', category: 'plumbing' });
  assert.equal(open.status, 201);
  assert.equal((open.body as { status: string }).status, 'open');

  assert.equal((D(app, 'POST', '/work-orders/wo-1/assign', 'own', { vendorPartyId: 'v-1' }).body as { status: string; assignedVendorPartyId: string }).status, 'assigned');
  assert.equal((D(app, 'POST', '/work-orders/wo-1/start', 'own', {}).body as { status: string }).status, 'in_progress');
  const done = D(app, 'POST', '/work-orders/wo-1/complete', 'own', { resolution: 'replaced washer' });
  assert.equal((done.body as { status: string; resolution: string }).status, 'completed');
  assert.equal((done.body as { resolution: string }).resolution, 'replaced washer');
});

test('invalid transition is rejected (cannot start a completed order)', () => {
  const app = makeApp();
  seed(app);
  D(app, 'POST', '/work-orders', 'own', { id: 'wo-x', title: 'x', spaceId: 's-u' });
  D(app, 'POST', '/work-orders/wo-x/complete', 'own', {});
  const res = D(app, 'POST', '/work-orders/wo-x/start', 'own', {});
  assert.equal(res.status, 409); // domain error → conflict
});

test('a work order can be cancelled with a reason', () => {
  const app = makeApp();
  seed(app);
  D(app, 'POST', '/work-orders', 'own', { id: 'wo-c', title: 'noisy AC', spaceId: 's-u' });
  const res = D(app, 'POST', '/work-orders/wo-c/cancel', 'own', { reason: 'tenant moved out' });
  assert.equal((res.body as { status: string; cancelReason: string }).status, 'cancelled');
  assert.equal((res.body as { cancelReason: string }).cancelReason, 'tenant moved out');
});

test('opening against an unknown space, or assigning an unknown vendor, is 404', () => {
  const app = makeApp();
  seed(app);
  assert.equal(D(app, 'POST', '/work-orders', 'own', { id: 'wo-bad', title: 't', spaceId: 'ghost' }).status, 404);
  D(app, 'POST', '/work-orders', 'own', { id: 'wo-2', title: 't', spaceId: 's-u' });
  assert.equal(D(app, 'POST', '/work-orders/wo-2/assign', 'own', { vendorPartyId: 'nobody' }).status, 404);
});

test('a space is optional — a work order can be raised without one', () => {
  const app = makeApp();
  const res = D(app, 'POST', '/work-orders', 'own', { id: 'wo-nospace', title: 'general' });
  assert.equal(res.status, 201);
});

test('an agent may manage work orders; a read-only user may only read them', () => {
  const app = makeApp();
  seed(app);
  assert.equal(D(app, 'POST', '/work-orders', 'bot', { id: 'wo-a', title: 'agent-raised', spaceId: 's-u' }).status, 201);
  assert.equal(D(app, 'POST', '/work-orders', 'ro', { id: 'wo-r', title: 'nope' }).status, 403);
  assert.equal(D(app, 'GET', '/work-orders', 'ro').status, 200); // reads are allowed
});

test('work orders are tenant-scoped', () => {
  const app = makeApp();
  seed(app);
  D(app, 'POST', '/work-orders', 'own', { id: 'wo-t1', title: 'rio only', spaceId: 's-u' });
  assert.equal(D(app, 'GET', '/work-orders/wo-t1', 'sp').status, 404); // other tenant
  assert.equal((D(app, 'GET', '/work-orders', 'sp').body as { workOrders: unknown[] }).workOrders.length, 0);
});

test('listing reflects the full lifecycle set for a tenant', () => {
  const app = makeApp();
  seed(app);
  D(app, 'POST', '/work-orders', 'own', { id: 'wo-l1', title: 'a', spaceId: 's-u' });
  D(app, 'POST', '/work-orders', 'own', { id: 'wo-l2', title: 'b' });
  assert.equal((D(app, 'GET', '/work-orders', 'own').body as { workOrders: unknown[] }).workOrders.length, 2);
});

test('completing with a bill links the AP bill to the work order (#3 → #22)', () => {
  const app = makeApp();
  seed(app);
  D(app, 'POST', '/work-orders', 'own', { id: 'wo-bill', title: 'boiler', spaceId: 's-u' });
  D(app, 'POST', '/work-orders/wo-bill/assign', 'own', { vendorPartyId: 'v-1' });
  // Record the repair cost as an AP bill to the vendor, then close the WO against it.
  D(app, 'POST', '/bills', 'own', { id: 'b-boiler', payeeId: 'v-1', dueAt: '2026-07-15', lines: [{ description: 'boiler repair', account: 'expenses:supplier', amountCents: 90000 }] });
  const done = D(app, 'POST', '/work-orders/wo-bill/complete', 'own', { billId: 'b-boiler', resolution: 'new boiler' });
  assert.equal((done.body as { status: string; billId: string }).status, 'completed');
  assert.equal((done.body as { billId: string }).billId, 'b-boiler');
  // The vendor payment side already balances through the ledger.
  assert.doesNotThrow(() => app.ledger.assertBalanced());
});
