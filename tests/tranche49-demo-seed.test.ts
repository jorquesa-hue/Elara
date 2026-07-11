// Tranche 49 — Demo-data seeder. POST /demo/seed loads a realistic mixed-portfolio
// sample (Ilhabela) through the normal kernel path, so every surface is populated
// and every invariant still holds. Idempotent, gated by masterdata.manage. Plus a
// DURABILITY round-trip: the seeded world projects to SQL and survives a
// snapshot→rehydrate, so the auto-flush persists it and a restart reloads it. 11 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';
import { buildDemoWorld } from '../src/demo-data.ts';
import { projectWorld } from '../src/persistence/project.ts';

const NOW = '2026-07-11T00:00:00Z';
function makeApp() {
  const mgr: AuthContext = { actor: 'm', tenantId: 'jq', role: 'manager' };
  const fd: AuthContext = { actor: 'f', tenantId: 'jq', role: 'front_desk' };
  const app = new App({ authenticator: new StaticTokenAuthenticator({ mgr, fd }), now: () => NOW });
  return { app };
}
const D = (app: App, method: string, path: string, token = 'mgr', body?: Record<string, unknown>) =>
  app.dispatch({ method, path, bearer: `Bearer ${token}`, body });

test('seeding returns 201 with per-store counts', () => {
  const { app } = makeApp();
  const res = D(app, 'POST', '/demo/seed');
  assert.equal(res.status, 201);
  const body = res.body as { seeded: boolean; counts: Record<string, number> };
  assert.equal(body.seeded, true);
  assert.ok(body.counts.agreements! >= 8);
  assert.ok(body.counts.invoices! >= 8);
  assert.ok(body.counts.workOrders! >= 3);
  assert.ok(body.counts.leads! >= 5);
});

test('seeding is idempotent — a second call is a no-op', () => {
  const { app } = makeApp();
  D(app, 'POST', '/demo/seed');
  const second = D(app, 'POST', '/demo/seed');
  assert.equal(second.status, 201);
  assert.equal((second.body as { seeded: boolean }).seeded, false);
  // Still exactly one set of agreements.
  const list = D(app, 'GET', '/agreements');
  const w = buildDemoWorld('jq', NOW);
  assert.equal((list.body as { agreements: unknown[] }).agreements.length, w.agreements.length);
});

test('the ledger balances after seeding (invariant 6)', () => {
  const { app } = makeApp();
  D(app, 'POST', '/demo/seed');
  const tb = D(app, 'GET', '/ledger/trial-balance');
  assert.equal(tb.status, 200);
  assert.equal((tb.body as { balanced: boolean }).balanced, true);
});

test('units, agreements and their kinds are populated (mixed portfolio)', () => {
  const { app } = makeApp();
  D(app, 'POST', '/demo/seed');
  const ags = (D(app, 'GET', '/agreements').body as { agreements: Array<{ kind: string }> }).agreements;
  const kinds = new Set(ags.map((a) => a.kind));
  // A genuinely mixed portfolio: nightly + monthly + lease all present.
  assert.ok(kinds.has('nightly'));
  assert.ok(kinds.has('monthly'));
  assert.ok(kinds.has('lease'));
});

test('bills, work orders and leads are reachable through their endpoints', () => {
  const { app } = makeApp();
  D(app, 'POST', '/demo/seed');
  assert.ok((D(app, 'GET', '/bills').body as { bills: unknown[] }).bills.length >= 3);
  assert.ok((D(app, 'GET', '/work-orders').body as { workOrders: unknown[] }).workOrders.length >= 3);
  assert.ok((D(app, 'GET', '/leads').body as { leads: unknown[] }).leads.length >= 5);
});

test('seeded data drives real insights — overdue receivables surface', () => {
  const { app } = makeApp();
  D(app, 'POST', '/demo/seed');
  const ins = (D(app, 'GET', '/reports/insights').body as { insights: Array<{ title: string; severity: string }> }).insights;
  // The sample intentionally includes overdue invoices → a collections finding.
  assert.ok(ins.some((i) => /overdue/i.test(i.title)), `insights: ${ins.map((i) => i.title).join(' | ')}`);
});

test('the collections report lists the seeded overdue invoices', () => {
  const { app } = makeApp();
  D(app, 'POST', '/demo/seed');
  const rep = D(app, 'GET', '/reports/collections').body as { report: { rows: unknown[] } };
  assert.ok(rep.report.rows.length >= 2); // lease-1 June + student lease are overdue
});

test('seeding requires masterdata.manage — front desk cannot', () => {
  const { app } = makeApp();
  const res = D(app, 'POST', '/demo/seed', 'fd');
  assert.equal(res.status, 403);
});

test('seeded holds do not double-book — every unit hold is distinct', () => {
  const { app } = makeApp();
  const res = D(app, 'POST', '/demo/seed');
  // If any two demo agreements collided on a unit+window, Calendar.hold would have
  // thrown and the seed would not have reached 201 seeded:true.
  assert.equal((res.body as { seeded: boolean }).seeded, true);
  const w = buildDemoWorld('jq', NOW);
  // Sanity: distinct units per overlapping active stay in the sample data.
  const holdKeys = new Set(w.agreements.map((a) => `${a.unitCode}`));
  assert.ok(holdKeys.size >= 8);
});

test('the seeded world projects to SQL — the durable write arm can persist it', () => {
  const { app } = makeApp();
  D(app, 'POST', '/demo/seed');
  // snapshotWorld folds the tenant slice into a FK-ordered WorldData; projectWorld
  // turns it into the parameterized INSERTs the edge backend runs. If this yields
  // statements without throwing, the auto-flush (flush-after-write) can persist it.
  const stmts = projectWorld(app.snapshotWorld('jq'));
  assert.ok(stmts.length > 100, `expected a rich statement batch, got ${stmts.length}`);
  assert.ok(stmts.some((s) => /insert into agreement\b/.test(s.text)));
  assert.ok(stmts.some((s) => /insert into invoice\b/.test(s.text)));
  assert.ok(stmts.some((s) => /insert into journal_line\b/.test(s.text)));
});

test('the seeded world survives a snapshot→rehydrate (a restart reloads it intact)', () => {
  const { app } = makeApp();
  D(app, 'POST', '/demo/seed');
  const before = app.snapshotWorld('jq');

  // A fresh process rehydrates from the persisted world, then re-snapshots.
  const mgr: AuthContext = { actor: 'm', tenantId: 'jq', role: 'manager' };
  const restarted = new App({ authenticator: new StaticTokenAuthenticator({ mgr }), now: () => NOW });
  restarted.rehydrate(before);

  const ags = (restarted.dispatch({ method: 'GET', path: '/agreements', bearer: 'Bearer mgr', body: {} }).body as { agreements: unknown[] }).agreements;
  assert.equal(ags.length, before.agreements.length); // every agreement came back
  const tb = restarted.dispatch({ method: 'GET', path: '/ledger/trial-balance', bearer: 'Bearer mgr', body: {} }).body as { balanced: boolean };
  assert.equal(tb.balanced, true); // ledger reloaded and still balances
  // Insights recompute over the reloaded data — the overdue receivables persist.
  const ins = (restarted.dispatch({ method: 'GET', path: '/reports/insights', bearer: 'Bearer mgr', body: {} }).body as { insights: Array<{ title: string }> }).insights;
  assert.ok(ins.some((i) => /overdue/i.test(i.title)));
});
