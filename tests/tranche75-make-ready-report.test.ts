// Tranche 75 — Phase 5B: turn-time analytics. A make-ready aging report (every
// turn with days-in-turn + the turn-time KPIs) and a "stuck in make-ready"
// insight. Feeds the ops director's turn scorecard off the Phase 5A turn board.
// 7 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';

// A fixed "today" 20 days after the vacate dates so turns read as long/stuck.
const NOW = '2026-07-21T00:00:00Z';
const own: AuthContext = { actor: 'own', tenantId: 'mf', role: 'owner' };
const ro: AuthContext = { actor: 'r', tenantId: 'mf', role: 'read_only' };

function mkApp() {
  const app = new App({ authenticator: new StaticTokenAuthenticator({ own, ro }), units: [], now: () => NOW });
  D(app, 'PUT', '/config', { displayName: 'Greyline', country: 'US' });
  D(app, 'POST', '/units', { id: 'u-1', code: 'A-1', label: 'Apt 101' });
  D(app, 'POST', '/units', { id: 'u-2', code: 'A-2', label: 'Apt 102' });
  return app;
}
const D = (app: App, method: string, path: string, body?: Record<string, unknown>, token = 'own') =>
  app.dispatch({ method, path, bearer: `Bearer ${token}`, body: body ?? {} });

function seedTurns(app: App) {
  // u-1: open since 2026-07-01 → 20 days in turn (stuck).
  D(app, 'POST', '/turns', { id: 'turn-1', unitId: 'u-1', vacatedAt: '2026-07-01T00:00:00Z' });
  // u-2: opened 2026-07-15, all tasks done + ready same window → a fast finished turn.
  D(app, 'POST', '/turns', { id: 'turn-2', unitId: 'u-2', vacatedAt: '2026-07-18T00:00:00Z' });
  for (const k of ['clean', 'paint', 'repair', 'inspect', 'keys']) D(app, 'POST', '/turns/turn-2/task', { key: k, done: true });
  D(app, 'POST', '/turns/turn-2/ready', {});
}

type Rep = { report: { rows: Array<{ unit: string; status: string; days: number; openTasks: number }>; kpis: Array<{ label: string; value: number }> } };
const rep = (app: App) => (D(app, 'GET', '/reports/make_ready', { from: '2026-07-01', to: '2026-08-01' }).body as Rep).report;
const kpi = (r: Rep['report'], label: string) => r.kpis.find((k) => k.label === label)!.value;

test('the make-ready report lists each turn with its days-in-turn, longest first', () => {
  const app = mkApp(); seedTurns(app);
  const r = rep(app);
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0]!.unit, 'Apt 101'); // 20 days, longest → first
  assert.equal(r.rows[0]!.days, 20);
  assert.equal(r.rows[0]!.status, 'open');
});

test('the KPIs count in-turn, made-ready, avg-days-to-ready and longest open', () => {
  const app = mkApp(); seedTurns(app);
  const r = rep(app);
  assert.equal(kpi(r, 'In turn'), 1);        // u-1 still open
  assert.equal(kpi(r, 'Made ready'), 1);     // u-2 ready
  assert.equal(kpi(r, 'Avg days to ready'), 3); // u-2 vacated 07-18, ready 07-21 → 3
  assert.equal(kpi(r, 'Longest open (days)'), 20);
});

test('a stuck-turn insight fires for units 7+ days in make-ready', () => {
  const app = mkApp(); seedTurns(app);
  const insights = (D(app, 'GET', '/reports/insights', { from: '2026-07-01', to: '2026-08-01' }).body as { insights: Array<{ title: string }> }).insights;
  assert.ok(insights.some((i) => /stuck in make-ready/.test(i.title)));
});

test('no stuck insight when turns are fresh', () => {
  const app = new App({ authenticator: new StaticTokenAuthenticator({ own }), units: [], now: () => '2026-07-03T00:00:00Z' });
  D(app, 'PUT', '/config', { displayName: 'G', country: 'US' });
  D(app, 'POST', '/units', { id: 'u-1', code: 'A-1', label: 'Apt 101' });
  D(app, 'POST', '/turns', { id: 'turn-1', unitId: 'u-1', vacatedAt: '2026-07-01T00:00:00Z' }); // 2 days
  const insights = (D(app, 'GET', '/reports/insights', { from: '2026-07-01', to: '2026-08-01' }).body as { insights: Array<{ title: string }> }).insights;
  assert.ok(!insights.some((i) => /stuck in make-ready/.test(i.title)));
});

test('make_ready is in the report catalog', () => {
  const app = mkApp();
  const catalog = (D(app, 'GET', '/reports/catalog').body as { reports: Array<{ key: string }> }).reports;
  assert.ok(catalog.some((c) => c.key === 'make_ready'));
});

test('an empty portfolio yields zero KPIs, no error', () => {
  const app = mkApp();
  const r = rep(app);
  assert.equal(r.rows.length, 0);
  assert.equal(kpi(r, 'In turn'), 0);
  assert.equal(kpi(r, 'Avg days to ready'), 0);
});

test('read_only may read the make-ready report', () => {
  const app = mkApp(); seedTurns(app);
  assert.equal(D(app, 'GET', '/reports/make_ready', { from: '2026-07-01', to: '2026-08-01' }, 'ro').status, 200);
});
