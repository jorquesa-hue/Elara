// Tranche 17 — Phase 2 module 3: move-in / move-out (#19/#18) and inspections
// (vistoria). Move events are recorded on the event-sourced agreement; an
// inspection captures a condition checklist + damage estimate that informs the
// move-out deposit refund (which flows through the existing deposit path). 10 tests.

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
  const agent: AuthContext = { actor: 'bot', tenantId: 't1', role: 'agent' };
  const reader: AuthContext = { actor: 'aud', tenantId: 't1', role: 'read_only' };
  const other: AuthContext = { actor: 'sp', tenantId: 't2', role: 'owner' };
  const auth = new StaticTokenAuthenticator({ own: owner, bot: agent, ro: reader, sp: other });
  return new App({ authenticator: auth, units: [{ id: 'u-1', tenantId: 't1' }], now: () => T });
}
function bookActive(app: App, id = 'ag-1') {
  D(app, 'POST', '/agreements', 'own', { id, guestId: 'g-1', unitId: 'u-1', kind: 'monthly', start: '2026-07-01', end: '2027-07-01', rateCents: 300000 });
  D(app, 'POST', `/agreements/${id}/activate`, 'own', {});
}
const events = (app: App, id: string) => (D(app, 'GET', `/agreements/${id}`, 'own').body as { history: Array<{ type: string; payload: Record<string, unknown> }> }).history;

test('move-in and move-out are recorded as agreement events (#19/#18)', () => {
  const app = makeApp(); bookActive(app);
  assert.equal(D(app, 'POST', '/agreements/ag-1/move-in', 'own', {}).status, 200);
  assert.equal(D(app, 'POST', '/agreements/ag-1/move-out', 'own', { note: 'keys returned' }).status, 200);
  const types = events(app, 'ag-1').map((e) => e.type);
  assert.ok(types.includes('moved_in'));
  assert.ok(types.includes('moved_out'));
});

test('cannot move in on a draft agreement (409)', () => {
  const app = makeApp();
  D(app, 'POST', '/agreements', 'own', { id: 'ag-d', guestId: 'g-1', unitId: 'u-1', kind: 'monthly', start: '2026-07-01', end: '2027-07-01', rateCents: 300000 });
  assert.equal(D(app, 'POST', '/agreements/ag-d/move-in', 'own', {}).status, 409);
});

test('an agent may record move-in (agreement.move is operational)', () => {
  const app = makeApp(); bookActive(app);
  assert.equal(D(app, 'POST', '/agreements/ag-1/move-in', 'bot', {}).status, 200);
});

test('schedule then complete a move-out inspection with a damage estimate', () => {
  const app = makeApp(); bookActive(app);
  const sched = D(app, 'POST', '/inspections', 'own', { id: 'insp-1', agreementId: 'ag-1', kind: 'move_out' });
  assert.equal(sched.status, 201);
  assert.equal((sched.body as { status: string }).status, 'scheduled');
  const done = D(app, 'POST', '/inspections/insp-1/complete', 'own', {
    items: [{ area: 'kitchen', condition: 'damaged', note: 'burnt countertop' }, { area: 'bath', condition: 'ok' }],
    damageCents: 8000,
  });
  assert.equal((done.body as { status: string; damageCents: number }).status, 'completed');
  assert.equal((done.body as { damageCents: number }).damageCents, 8000);
  assert.equal((done.body as { items: unknown[] }).items.length, 2);
});

test('inspection for an unknown agreement is 404; unknown space is 404', () => {
  const app = makeApp(); bookActive(app);
  assert.equal(D(app, 'POST', '/inspections', 'own', { id: 'i-x', agreementId: 'ghost', kind: 'move_in' }).status, 404);
  assert.equal(D(app, 'POST', '/inspections', 'own', { id: 'i-y', agreementId: 'ag-1', kind: 'move_in', spaceId: 'nospace' }).status, 404);
});

test('move-out can reference its inspection; the event carries the id', () => {
  const app = makeApp(); bookActive(app);
  D(app, 'POST', '/inspections', 'own', { id: 'insp-mo', agreementId: 'ag-1', kind: 'move_out' });
  D(app, 'POST', '/agreements/ag-1/move-out', 'own', { inspectionId: 'insp-mo' });
  const mo = events(app, 'ag-1').find((e) => e.type === 'moved_out')!;
  assert.equal(mo.payload['inspectionId'], 'insp-mo');
});

test('damage estimate informs the move-out deposit refund', () => {
  const app = makeApp(); bookActive(app);
  D(app, 'POST', '/deposits', 'own', { id: 'dep-1', agreementId: 'ag-1', amountCents: 50000 });
  D(app, 'POST', '/inspections', 'own', { id: 'insp-d', agreementId: 'ag-1', kind: 'move_out' });
  const insp = D(app, 'POST', '/inspections/insp-d/complete', 'own', { items: [{ area: 'wall', condition: 'damaged' }], damageCents: 8000 }).body as { damageCents: number };
  // Operator refunds the deposit less the assessed damage.
  const ref = D(app, 'POST', '/deposits/dep-1/refund', 'own', { deductions: [{ reason: 'wall damage', amountCents: insp.damageCents }] });
  assert.equal(ref.status, 200);
  assert.equal((ref.body as { refundedCents: number }).refundedCents, 42000); // 50000 − 8000
});

test('a scheduled inspection can be cancelled; a completed one cannot', () => {
  const app = makeApp(); bookActive(app);
  D(app, 'POST', '/inspections', 'own', { id: 'insp-c', agreementId: 'ag-1', kind: 'move_in' });
  assert.equal(D(app, 'POST', '/inspections/insp-c/cancel', 'own', {}).status, 200);
  D(app, 'POST', '/inspections', 'own', { id: 'insp-done', agreementId: 'ag-1', kind: 'move_in' });
  D(app, 'POST', '/inspections/insp-done/complete', 'own', { items: [] });
  assert.equal(D(app, 'POST', '/inspections/insp-done/cancel', 'own', {}).status, 409);
});

test('read_only cannot schedule an inspection but can read; tenant-scoped', () => {
  const app = makeApp(); bookActive(app);
  assert.equal(D(app, 'POST', '/inspections', 'ro', { id: 'i-ro', agreementId: 'ag-1', kind: 'move_in' }).status, 403);
  D(app, 'POST', '/inspections', 'own', { id: 'i-live', agreementId: 'ag-1', kind: 'move_in' });
  assert.equal(D(app, 'GET', '/inspections', 'ro').status, 200);
  assert.equal(D(app, 'GET', '/inspections/i-live', 'sp').status, 404); // other tenant
});

test('inspections list per agreement', () => {
  const app = makeApp(); bookActive(app);
  D(app, 'POST', '/inspections', 'own', { id: 'i-1', agreementId: 'ag-1', kind: 'move_in' });
  D(app, 'POST', '/inspections', 'own', { id: 'i-2', agreementId: 'ag-1', kind: 'move_out' });
  assert.equal((D(app, 'GET', '/agreements/ag-1/inspections', 'own').body as { inspections: unknown[] }).inspections.length, 2);
});
