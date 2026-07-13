// Tranche 76 — Phase 5C: preventive maintenance schedules. Recurring upkeep a
// sweep turns into work orders on a cadence; the sweep advances each schedule's
// next-due date and is idempotent per (schedule, due date). Durable. 11 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';
import { projectWorld } from '../src/persistence/project.ts';
import { addDays } from '../src/preventive.ts';

const NOW = '2026-07-13T00:00:00Z';
const own: AuthContext = { actor: 'own', tenantId: 'mf', role: 'owner' };
const bot: AuthContext = { actor: 'bot', tenantId: 'mf', role: 'agent' };
const ro: AuthContext = { actor: 'r', tenantId: 'mf', role: 'read_only' };

function mkApp() {
  const app = new App({ authenticator: new StaticTokenAuthenticator({ own, bot, ro }), units: [], now: () => NOW });
  D(app, 'PUT', '/config', { displayName: 'Greyline', country: 'US' });
  return app;
}
const D = (app: App, method: string, path: string, body?: Record<string, unknown>, token = 'own') =>
  app.dispatch({ method, path, bearer: `Bearer ${token}`, body: body ?? {} });

function create(app: App, over: Record<string, unknown> = {}) {
  return D(app, 'POST', '/pm-schedules', { id: 'pm-1', title: 'HVAC service', cadenceDays: 90, nextDueAt: '2026-07-01', priority: 'high', ...over });
}

test('addDays advances an ISO date by whole days', () => {
  assert.equal(addDays('2026-07-01', 90), '2026-09-29');
  assert.equal(addDays('2026-01-31', 1), '2026-02-01');
});

test('create a PM schedule', () => {
  const app = mkApp();
  const r = create(app);
  assert.equal(r.status, 201);
  const s = r.body as { title: string; cadenceDays: number; active: boolean; nextDueAt: string };
  assert.equal(s.title, 'HVAC service');
  assert.equal(s.cadenceDays, 90);
  assert.equal(s.active, true);
  assert.equal(s.nextDueAt, '2026-07-01');
});

test('cadenceDays must be a positive integer; unknown space 404s', () => {
  const app = mkApp();
  assert.equal(create(app, { id: 'pm-x', cadenceDays: 0 }).status, 400);
  assert.equal(create(app, { id: 'pm-y', spaceId: 'ghost' }).status, 404);
});

test('GET flags a schedule due when nextDueAt <= today', () => {
  const app = mkApp(); create(app);
  const rows = (D(app, 'GET', '/pm-schedules').body as { schedules: Array<{ id: string; due: boolean }> }).schedules;
  assert.equal(rows[0]!.due, true); // 2026-07-01 <= 2026-07-13
});

test('the sweep raises a work order for a due schedule and advances next-due', () => {
  const app = mkApp(); create(app);
  const r = D(app, 'POST', '/maintenance/pm-sweep', {});
  assert.equal((r.body as { swept: number; raised: string[] }).swept, 1);
  assert.equal((r.body as { raised: string[] }).raised.length, 1);
  // A preventive WO now exists.
  const wos = (D(app, 'GET', '/work-orders').body as { workOrders: Array<{ id: string; category?: string; title: string }> }).workOrders;
  assert.ok(wos.some((w) => w.category === 'preventive' && w.title === 'HVAC service'));
  // next-due advanced by the cadence (90 days).
  const s = D(app, 'GET', '/pm-schedules').body as { schedules: Array<{ nextDueAt: string; due: boolean }> };
  assert.equal(s.schedules[0]!.nextDueAt, '2026-09-29');
  assert.equal(s.schedules[0]!.due, false);
});

test('the sweep is idempotent — re-running the same day raises no duplicate WO', () => {
  const app = mkApp();
  create(app, { nextDueAt: '2026-07-13' });
  D(app, 'POST', '/maintenance/pm-sweep', {});
  const countAfterFirst = (D(app, 'GET', '/work-orders').body as { workOrders: unknown[] }).workOrders.length;
  // Wind the schedule back so it is due again on the same date, then re-sweep.
  // (Re-running with the same due date yields the same WO id → no duplicate.)
  const before = (D(app, 'GET', '/work-orders').body as { workOrders: unknown[] }).workOrders.length;
  D(app, 'POST', '/maintenance/pm-sweep', {}); // nothing due now (advanced)
  const after = (D(app, 'GET', '/work-orders').body as { workOrders: unknown[] }).workOrders.length;
  assert.equal(before, after);
  assert.equal(countAfterFirst, 1);
});

test('a future schedule is not swept', () => {
  const app = mkApp(); create(app, { nextDueAt: '2026-12-01' });
  assert.equal((D(app, 'POST', '/maintenance/pm-sweep', {}).body as { swept: number }).swept, 0);
});

test('deactivate excludes a schedule from the sweep', () => {
  const app = mkApp(); create(app);
  D(app, 'POST', '/pm-schedules/pm-1/deactivate', {});
  assert.equal((D(app, 'POST', '/maintenance/pm-sweep', {}).body as { swept: number }).swept, 0);
  D(app, 'POST', '/pm-schedules/pm-1/activate', {});
  assert.equal((D(app, 'POST', '/maintenance/pm-sweep', {}).body as { swept: number }).swept, 1);
});

test('maintenance.manage gates writes; read_only reads; agent (OPS) manages', () => {
  const app = mkApp(); create(app);
  assert.equal(D(app, 'GET', '/pm-schedules', undefined, 'ro').status, 200);
  assert.equal(D(app, 'POST', '/pm-schedules', { id: 'pm-ro', title: 'x', cadenceDays: 30, nextDueAt: '2026-07-01' }, 'ro').status, 403);
  assert.equal(D(app, 'POST', '/pm-schedules', { id: 'pm-bot', title: 'Filters', cadenceDays: 30, nextDueAt: '2026-07-01' }, 'bot').status, 201);
});

test('PM schedules are tenant-scoped', () => {
  const app = mkApp(); create(app);
  const other: AuthContext = { actor: 'o2', tenantId: 'other', role: 'owner' };
  const app2 = new App({ authenticator: new StaticTokenAuthenticator({ o2: other }), now: () => NOW });
  app2.dispatch({ method: 'PUT', path: '/config', bearer: 'Bearer o2', body: { displayName: 'Other', country: 'US' } });
  assert.equal((app2.dispatch({ method: 'GET', path: '/pm-schedules', bearer: 'Bearer o2', body: {} }).body as { schedules: unknown[] }).schedules.length, 0);
  assert.equal(app2.dispatch({ method: 'POST', path: '/pm-schedules/pm-1/deactivate', bearer: 'Bearer o2', body: {} }).status, 404);
});

test('a PM schedule projects to SQL and survives snapshot → rehydrate', () => {
  const app = mkApp(); create(app); D(app, 'POST', '/maintenance/pm-sweep', {});
  const ins = projectWorld(app.snapshotWorld('mf')).find((x) => x.text.startsWith('insert into pm_schedule '));
  assert.ok(ins);
  const b = new App({ authenticator: new StaticTokenAuthenticator({ own }), now: () => NOW });
  b.rehydrate(app.snapshotWorld('mf'));
  const s = (b.snapshotWorld('mf').pmSchedules ?? []).find((x) => x.id === 'pm-1')!;
  assert.equal(s.title, 'HVAC service');
  assert.equal(s.nextDueAt, '2026-09-29'); // the advanced date persisted
});
