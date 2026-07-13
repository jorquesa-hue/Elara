// Tranche 74 — Phase 5A: unit turns (make-ready). The operations board tracking
// a vacant unit through its make-ready checklist to rent-ready; turn time
// (vacate → ready) is the ops KPI. Durable (projects to SQL + snapshot→rehydrate).
// 12 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';
import { projectWorld } from '../src/persistence/project.ts';
import { turnDays, DEFAULT_TURN_TASKS, type Turn } from '../src/turns.ts';

const NOW = '2026-07-13T00:00:00Z';
const own: AuthContext = { actor: 'own', tenantId: 'mf', role: 'owner' };
const bot: AuthContext = { actor: 'bot', tenantId: 'mf', role: 'agent' };
const ro: AuthContext = { actor: 'r', tenantId: 'mf', role: 'read_only' };

function mkApp() {
  const app = new App({ authenticator: new StaticTokenAuthenticator({ own, bot, ro }), units: [], now: () => NOW });
  D(app, 'PUT', '/config', { displayName: 'Greyline', country: 'US' });
  D(app, 'POST', '/units', { id: 'u-1', code: 'A-1', label: 'Apt 101' });
  return app;
}
const D = (app: App, method: string, path: string, body?: Record<string, unknown>, token = 'own') =>
  app.dispatch({ method, path, bearer: `Bearer ${token}`, body: body ?? {} });

function open(app: App, over: Record<string, unknown> = {}) {
  return D(app, 'POST', '/turns', { id: 'turn-1', unitId: 'u-1', vacatedAt: '2026-07-01T00:00:00Z', ...over });
}
function completeAll(app: App, id = 'turn-1') {
  for (const t of DEFAULT_TURN_TASKS) D(app, 'POST', `/turns/${id}/task`, { key: t.key, done: true });
}

test('turnDays measures vacate → ready (or asOf while open)', () => {
  const t: Turn = { id: 't', tenantId: 'mf', unitId: 'u', status: 'open', vacatedAt: '2026-07-01T00:00:00Z', tasks: [], createdAt: NOW };
  assert.equal(turnDays(t, '2026-07-13T00:00:00Z'), 12);
  assert.equal(turnDays({ ...t, status: 'ready', readyAt: '2026-07-06T00:00:00Z' }, NOW), 5);
});

test('open a turn — it starts with the default make-ready checklist', () => {
  const app = mkApp();
  const r = open(app);
  assert.equal(r.status, 201);
  const body = r.body as { status: string; tasks: Array<{ key: string; done: boolean }> };
  assert.equal(body.status, 'open');
  assert.equal(body.tasks.length, DEFAULT_TURN_TASKS.length);
  assert.ok(body.tasks.every((t) => !t.done));
});

test('an unknown unit 404s', () => {
  const app = mkApp();
  assert.equal(open(app, { unitId: 'ghost' }).status, 404);
});

test('completing a task moves the turn to in_progress', () => {
  const app = mkApp(); open(app);
  const r = D(app, 'POST', '/turns/turn-1/task', { key: 'clean', done: true });
  assert.equal((r.body as { status: string }).status, 'in_progress');
});

test('a turn cannot go ready with incomplete tasks; once all done it can', () => {
  const app = mkApp(); open(app);
  assert.equal(D(app, 'POST', '/turns/turn-1/ready', {}).status, 409);
  completeAll(app);
  const r = D(app, 'POST', '/turns/turn-1/ready', {});
  assert.equal((r.body as { status: string; readyAt: string }).status, 'ready');
  assert.ok((r.body as { readyAt: string }).readyAt);
});

test('a task can be un-done', () => {
  const app = mkApp(); open(app);
  D(app, 'POST', '/turns/turn-1/task', { key: 'clean', done: true });
  const r = D(app, 'POST', '/turns/turn-1/task', { key: 'clean', done: false });
  assert.ok((r.body as { tasks: Array<{ key: string; done: boolean }> }).tasks.find((t) => t.key === 'clean')!.done === false);
});

test('an unknown task key 409s; a ready turn cannot be edited', () => {
  const app = mkApp(); open(app);
  assert.equal(D(app, 'POST', '/turns/turn-1/task', { key: 'nope', done: true }).status, 409);
  completeAll(app); D(app, 'POST', '/turns/turn-1/ready', {});
  assert.equal(D(app, 'POST', '/turns/turn-1/task', { key: 'clean', done: false }).status, 409);
  assert.equal(D(app, 'POST', '/turns/turn-1/cancel', {}).status, 409);
});

test('GET /turns lists turns with unit label, days and open-task count', () => {
  const app = mkApp(); open(app);
  D(app, 'POST', '/turns/turn-1/task', { key: 'clean', done: true });
  const turns = (D(app, 'GET', '/turns').body as { turns: Array<{ id: string; unitLabel: string; days: number; openTasks: number }> }).turns;
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.unitLabel, 'Apt 101');
  assert.equal(turns[0]!.days, 12); // 2026-07-01 → 2026-07-13
  assert.equal(turns[0]!.openTasks, DEFAULT_TURN_TASKS.length - 1);
});

test('turn.manage gates writes; read_only reads; agent (OPS) may manage', () => {
  const app = mkApp(); open(app);
  assert.equal(D(app, 'GET', '/turns', undefined, 'ro').status, 200);
  assert.equal(D(app, 'POST', '/turns', { id: 't-ro', unitId: 'u-1' }, 'ro').status, 403);
  assert.equal(D(app, 'POST', '/turns', { id: 't-bot', unitId: 'u-1', vacatedAt: NOW }, 'bot').status, 201);
});

test('turns are tenant-scoped', () => {
  const app = mkApp(); open(app);
  const other: AuthContext = { actor: 'o2', tenantId: 'other', role: 'owner' };
  const app2 = new App({ authenticator: new StaticTokenAuthenticator({ o2: other }), now: () => NOW });
  app2.dispatch({ method: 'PUT', path: '/config', bearer: 'Bearer o2', body: { displayName: 'Other', country: 'US' } });
  assert.equal(app2.dispatch({ method: 'GET', path: '/turns/turn-1', bearer: 'Bearer o2', body: {} }).status, 404);
});

test('a turn projects to SQL with a jsonb tasks checklist', () => {
  const app = mkApp(); open(app); D(app, 'POST', '/turns/turn-1/task', { key: 'clean', done: true });
  const ins = projectWorld(app.snapshotWorld('mf')).find((s) => s.text.startsWith('insert into unit_turn '));
  assert.ok(ins);
  assert.ok(ins!.text.includes('$7::jsonb'));
});

test('turns survive snapshot → rehydrate', () => {
  const app = mkApp(); open(app); D(app, 'POST', '/turns/turn-1/task', { key: 'clean', done: true });
  const b = new App({ authenticator: new StaticTokenAuthenticator({ own }), now: () => NOW });
  b.rehydrate(app.snapshotWorld('mf'));
  const t = (b.snapshotWorld('mf').unitTurns ?? []).find((x) => x.id === 'turn-1')!;
  assert.equal(t.status, 'in_progress');
  assert.equal(t.tasks.find((x) => x.key === 'clean')!.done, true);
  assert.equal(b.dispatch({ method: 'GET', path: '/turns/turn-1', bearer: 'Bearer own', body: {} }).status, 200);
});
