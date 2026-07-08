// Tranche 16 — Phase 2 module 2: common-area reservations (#6). Booking a
// bookable space takes a calendar hold, so the DB's no-double-booking guarantee
// (invariant 4) covers amenities exactly like stays; cancelling frees the slot.
// 8 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';

const T = '2026-07-01T00:00:00Z';
const bearer = (t: string) => `Bearer ${t}`;
const D = (app: App, method: string, path: string, token: string, body?: Record<string, unknown>) =>
  app.dispatch({ method, path, bearer: bearer(token), body });

function makeApp() {
  const owner: AuthContext = { actor: 'ana', tenantId: 't1', role: 'owner' };
  const reader: AuthContext = { actor: 'aud', tenantId: 't1', role: 'read_only' };
  const other: AuthContext = { actor: 'sp', tenantId: 't2', role: 'owner' };
  const auth = new StaticTokenAuthenticator({ own: owner, ro: reader, sp: other });
  return new App({ authenticator: auth, now: () => T });
}
function seed(app: App) {
  D(app, 'POST', '/spaces', 'own', { id: 'lounge', type: 'common', code: 'LOUNGE', label: 'Rooftop lounge', leasable: false });
  D(app, 'POST', '/spaces', 'own', { id: 'unit-1', type: 'unit', code: 'U1', label: 'Unit 1', leasable: true });
  D(app, 'POST', '/parties', 'own', { id: 'p-res', kind: 'person', displayName: 'Resident' });
}
const resv = (n: string, start: string, end: string) => ({ id: n, spaceId: 'lounge', holderPartyId: 'p-res', start, end, priceCents: 5000 });

test('reserve a common area — status reserved, price carried', () => {
  const app = makeApp(); seed(app);
  const r = D(app, 'POST', '/reservations', 'own', resv('rv-1', '2026-08-01T18:00:00Z', '2026-08-01T22:00:00Z'));
  assert.equal(r.status, 201);
  assert.equal((r.body as { status: string; priceCents: number }).status, 'reserved');
  assert.equal((r.body as { priceCents: number }).priceCents, 5000);
});

test('overlapping reservation on the same space is rejected (invariant 4 → 409)', () => {
  const app = makeApp(); seed(app);
  D(app, 'POST', '/reservations', 'own', resv('rv-a', '2026-08-01T18:00:00Z', '2026-08-01T22:00:00Z'));
  const clash = D(app, 'POST', '/reservations', 'own', resv('rv-b', '2026-08-01T20:00:00Z', '2026-08-01T23:00:00Z'));
  assert.equal(clash.status, 409);
});

test('non-overlapping reservations on the same space are allowed', () => {
  const app = makeApp(); seed(app);
  assert.equal(D(app, 'POST', '/reservations', 'own', resv('rv-m', '2026-08-01T08:00:00Z', '2026-08-01T10:00:00Z')).status, 201);
  assert.equal(D(app, 'POST', '/reservations', 'own', resv('rv-n', '2026-08-01T10:00:00Z', '2026-08-01T12:00:00Z')).status, 201);
});

test('a leasable unit is not bookable (400)', () => {
  const app = makeApp(); seed(app);
  const r = D(app, 'POST', '/reservations', 'own', { id: 'rv-u', spaceId: 'unit-1', holderPartyId: 'p-res', start: '2026-08-01T08:00:00Z', end: '2026-08-01T09:00:00Z' });
  assert.equal(r.status, 400);
});

test('unknown space or holder is 404', () => {
  const app = makeApp(); seed(app);
  assert.equal(D(app, 'POST', '/reservations', 'own', { id: 'rv-x', spaceId: 'ghost', holderPartyId: 'p-res', start: '2026-08-01T08:00:00Z', end: '2026-08-01T09:00:00Z' }).status, 404);
  assert.equal(D(app, 'POST', '/reservations', 'own', { id: 'rv-y', spaceId: 'lounge', holderPartyId: 'nobody', start: '2026-08-01T08:00:00Z', end: '2026-08-01T09:00:00Z' }).status, 404);
});

test('cancelling frees the slot so it can be re-booked', () => {
  const app = makeApp(); seed(app);
  D(app, 'POST', '/reservations', 'own', resv('rv-1', '2026-08-01T18:00:00Z', '2026-08-01T22:00:00Z'));
  // Same window is blocked while active…
  assert.equal(D(app, 'POST', '/reservations', 'own', resv('rv-2', '2026-08-01T18:00:00Z', '2026-08-01T22:00:00Z')).status, 409);
  assert.equal(D(app, 'POST', '/reservations/rv-1/cancel', 'own', {}).status, 200);
  // …and free after cancelling.
  assert.equal(D(app, 'POST', '/reservations', 'own', resv('rv-3', '2026-08-01T18:00:00Z', '2026-08-01T22:00:00Z')).status, 201);
});

test('read_only cannot reserve but can read; tenant-scoped', () => {
  const app = makeApp(); seed(app);
  assert.equal(D(app, 'POST', '/reservations', 'ro', resv('rv-ro', '2026-08-02T08:00:00Z', '2026-08-02T09:00:00Z')).status, 403);
  D(app, 'POST', '/reservations', 'own', resv('rv-live', '2026-08-02T08:00:00Z', '2026-08-02T09:00:00Z'));
  assert.equal(D(app, 'GET', '/reservations', 'ro').status, 200);
  assert.equal((D(app, 'GET', '/reservations', 'sp').body as { reservations: unknown[] }).reservations.length, 0); // other tenant
});

test('cancelling an already-cancelled reservation is a conflict', () => {
  const app = makeApp(); seed(app);
  D(app, 'POST', '/reservations', 'own', resv('rv-1', '2026-08-03T08:00:00Z', '2026-08-03T09:00:00Z'));
  D(app, 'POST', '/reservations/rv-1/cancel', 'own', {});
  assert.equal(D(app, 'POST', '/reservations/rv-1/cancel', 'own', {}).status, 409);
});
