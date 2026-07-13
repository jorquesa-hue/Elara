// Tranche 69 — Phase 2E: tour scheduling. The top of the leasing funnel — a
// prospect requests a tour of a unit, the office confirms, then completes it
// (advancing the linked lead to 'toured'), marks a no-show, or cancels. Durable
// (projects to SQL + survives snapshot→rehydrate). 12 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';
import { projectWorld } from '../src/persistence/project.ts';

const NOW = '2026-07-13T00:00:00Z';
const own: AuthContext = { actor: 'own', tenantId: 'mf', role: 'owner' };
const bot: AuthContext = { actor: 'bot', tenantId: 'mf', role: 'agent' };
const ro: AuthContext = { actor: 'r', tenantId: 'mf', role: 'read_only' };

function mkApp() {
  const app = new App({ authenticator: new StaticTokenAuthenticator({ own, bot, ro }), units: [], now: () => NOW });
  D(app, 'PUT', '/config', { displayName: 'Greyline', country: 'US' });
  D(app, 'POST', '/units', { id: 'u-1', code: 'A-1', label: 'Apt 101' });
  D(app, 'POST', '/leads', { id: 'ld-1', name: 'Bea Lima', source: 'website', estValueCents: 300000 });
  return app;
}
const D = (app: App, method: string, path: string, body?: Record<string, unknown>, token = 'own') =>
  app.dispatch({ method, path, bearer: `Bearer ${token}`, body: body ?? {} });

function book(app: App, over: Record<string, unknown> = {}) {
  return D(app, 'POST', '/tours', { id: 'tour-1', prospectName: 'Bea Lima', prospectEmail: 'bea@x.com', scheduledAt: '2026-07-20T15:00:00Z', leadId: 'ld-1', unitId: 'u-1', ...over });
}

test('schedule a tour', () => {
  const app = mkApp();
  const r = book(app);
  assert.equal(r.status, 201);
  assert.equal((r.body as { status: string }).status, 'requested');
  assert.equal((D(app, 'GET', '/tours').body as { tours: unknown[] }).tours.length, 1);
});

test('GET reads a single tour; unknown 404s', () => {
  const app = mkApp(); book(app);
  assert.equal((D(app, 'GET', '/tours/tour-1').body as { prospectName: string }).prospectName, 'Bea Lima');
  assert.equal(D(app, 'GET', '/tours/nope').status, 404);
});

test('an unknown linked unit 404s', () => {
  const app = mkApp();
  assert.equal(D(app, 'POST', '/tours', { id: 't-x', prospectName: 'X', scheduledAt: NOW, unitId: 'ghost' }).status, 404);
});

test('confirm then complete; completing advances the linked lead to toured', () => {
  const app = mkApp(); book(app);
  assert.equal((D(app, 'POST', '/tours/tour-1/confirm', {}).body as { status: string }).status, 'confirmed');
  assert.equal((D(app, 'POST', '/tours/tour-1/complete', {}).body as { status: string }).status, 'completed');
  assert.equal((D(app, 'GET', '/leads/ld-1').body as { stage: string }).stage, 'toured');
});

test('a tour can complete directly from requested', () => {
  const app = mkApp(); book(app);
  assert.equal((D(app, 'POST', '/tours/tour-1/complete', { notes: 'walk-in' }).body as { status: string; notes: string }).status, 'completed');
});

test('no-show and cancel transitions', () => {
  const app = mkApp();
  book(app, { id: 't-ns' });
  assert.equal((D(app, 'POST', '/tours/t-ns/no-show', {}).body as { status: string }).status, 'no_show');
  book(app, { id: 't-c' });
  assert.equal((D(app, 'POST', '/tours/t-c/cancel', { reason: 'reschedule' }).body as { status: string; cancelReason: string }).cancelReason, 'reschedule');
});

test('a completed tour cannot be cancelled', () => {
  const app = mkApp(); book(app);
  D(app, 'POST', '/tours/tour-1/complete', {});
  assert.equal(D(app, 'POST', '/tours/tour-1/cancel', {}).status, 409);
});

test('tour.manage gates writes; read_only reads; agent (OPS) may book', () => {
  const app = mkApp(); book(app);
  assert.equal(D(app, 'GET', '/tours', undefined, 'ro').status, 200);
  assert.equal(D(app, 'POST', '/tours', { id: 't-ro', prospectName: 'X', scheduledAt: NOW }, 'ro').status, 403);
  assert.equal(D(app, 'POST', '/tours', { id: 't-bot', prospectName: 'Cid', scheduledAt: NOW }, 'bot').status, 201);
});

test('tours are tenant-scoped', () => {
  const app = mkApp(); book(app);
  const other: AuthContext = { actor: 'o2', tenantId: 'other', role: 'owner' };
  const app2 = new App({ authenticator: new StaticTokenAuthenticator({ o2: other }), now: () => NOW });
  app2.dispatch({ method: 'PUT', path: '/config', bearer: 'Bearer o2', body: { displayName: 'Other', country: 'US' } });
  assert.equal(app2.dispatch({ method: 'GET', path: '/tours/tour-1', bearer: 'Bearer o2', body: {} }).status, 404);
});

test('a tour with no linked lead completes without error', () => {
  const app = mkApp();
  D(app, 'POST', '/tours', { id: 't-nolead', prospectName: 'Solo', scheduledAt: NOW });
  assert.equal(D(app, 'POST', '/tours/t-nolead/complete', {}).status, 200);
});

test('the tour projects to SQL with its columns', () => {
  const app = mkApp(); book(app);
  D(app, 'POST', '/tours/tour-1/complete', {});
  const stmts = projectWorld(app.snapshotWorld('mf'));
  const ins = stmts.find((s) => s.text.includes('insert into tour'));
  assert.ok(ins, 'a tour insert is projected');
  assert.ok(ins!.text.includes('prospect_name'));
  assert.ok(ins!.text.includes('scheduled_at'));
});

test('tours survive snapshot → rehydrate', () => {
  const app = mkApp(); book(app);
  D(app, 'POST', '/tours/tour-1/confirm', {});
  const b = new App({ authenticator: new StaticTokenAuthenticator({ own }), now: () => NOW });
  b.rehydrate(app.snapshotWorld('mf'));
  const t = (b.snapshotWorld('mf').tours ?? []).find((x) => x.id === 'tour-1')!;
  assert.equal(t.status, 'confirmed');
  assert.equal(t.prospectName, 'Bea Lima');
  // The rehydrated tour is reachable (tenant map rebuilt).
  assert.equal(b.dispatch({ method: 'GET', path: '/tours/tour-1', bearer: 'Bearer own', body: {} }).status, 200);
});
