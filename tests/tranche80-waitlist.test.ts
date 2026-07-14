// Tranche 80 — Phase 6D: prospect waitlist. Prospects queue for a floorplan when
// it's full; the office offers a freed unit to the FIFO top and converts that
// prospect into a CRM lead (the funnel resumes). RBAC-only, durable. 12 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';
import { projectWorld } from '../src/persistence/project.ts';
import { Waitlist } from '../src/waitlist.ts';

const NOW = '2026-07-13T00:00:00Z';
const own: AuthContext = { actor: 'own', tenantId: 'mf', role: 'owner' };
const bot: AuthContext = { actor: 'bot', tenantId: 'mf', role: 'agent' };
const ro: AuthContext = { actor: 'r', tenantId: 'mf', role: 'read_only' };

const D = (app: App, method: string, path: string, body?: Record<string, unknown>, token = 'own') =>
  app.dispatch({ method, path, bearer: `Bearer ${token}`, body: body ?? {} });

function mkApp() {
  const app = new App({ authenticator: new StaticTokenAuthenticator({ own, bot, r: ro }), units: [], now: () => NOW });
  D(app, 'PUT', '/config', { displayName: 'Greyline', country: 'US' });
  D(app, 'POST', '/unit-types', { id: 'ut-2br', code: '2BR', name: 'Two Bedroom' });
  return app;
}
function join(app: App, over: Record<string, unknown> = {}, token = 'own') {
  return D(app, 'POST', '/waitlist', { id: 'wl-1', prospectName: 'Dana Reed', prospectEmail: 'dana@x.com', typeId: 'ut-2br', joinedAt: '2026-07-05T00:00:00Z', ...over }, token);
}

test('the queue is FIFO by join time (pure)', () => {
  const wl = new Waitlist();
  wl.join({ id: 'b', tenantId: 'mf', prospectName: 'B', joinedAt: '2026-07-06T00:00:00Z', typeId: 't1' });
  wl.join({ id: 'a', tenantId: 'mf', prospectName: 'A', joinedAt: '2026-07-05T00:00:00Z', typeId: 't1' });
  const q = wl.queue('mf', 't1');
  assert.deepEqual(q.map((e) => e.id), ['a', 'b']); // earliest join first
  assert.equal(wl.position('a'), 1);
  assert.equal(wl.position('b'), 2);
});

test('join a prospect; the row folds floorplan name + position', () => {
  const app = mkApp();
  const r = join(app);
  assert.equal(r.status, 201);
  const e = r.body as { floorplanName: string; position: number; status: string };
  assert.equal(e.floorplanName, 'Two Bedroom');
  assert.equal(e.position, 1);
  assert.equal(e.status, 'waiting');
});

test('unknown floorplan 404; unknown property 404', () => {
  const app = mkApp();
  assert.equal(join(app, { id: 'wl-x', typeId: 'ghost' }).status, 404);
  assert.equal(join(app, { id: 'wl-y', propertyId: 'nope' }).status, 404);
});

test('offer advances waiting → offered', () => {
  const app = mkApp(); join(app);
  const r = D(app, 'POST', '/waitlist/wl-1/offer', {});
  assert.equal(r.status, 200);
  assert.equal((r.body as { status: string }).status, 'offered');
  // Cannot offer twice.
  assert.equal(D(app, 'POST', '/waitlist/wl-1/offer', {}).status, 409);
});

test('convert creates a CRM lead (source waitlist) and closes the entry', () => {
  const app = mkApp(); join(app);
  const r = D(app, 'POST', '/waitlist/wl-1/convert', {});
  assert.equal(r.status, 200);
  const out = r.body as { entry: { status: string; leadId: string }; lead: { id: string; name: string; source: string } };
  assert.equal(out.entry.status, 'converted');
  assert.equal(out.lead.source, 'waitlist');
  assert.equal(out.lead.name, 'Dana Reed');
  // The lead now shows in the CRM pipeline.
  const leads = (D(app, 'GET', '/leads').body as { leads: Array<{ id: string }> }).leads;
  assert.ok(leads.some((l) => l.id === out.lead.id));
  // A converted entry cannot convert again.
  assert.equal(D(app, 'POST', '/waitlist/wl-1/convert', {}).status, 409);
});

test('a converted prospect leaves the active queue', () => {
  const app = mkApp();
  join(app, { id: 'wl-1', joinedAt: '2026-07-05T00:00:00Z' });
  join(app, { id: 'wl-2', prospectName: 'Eve', joinedAt: '2026-07-06T00:00:00Z' });
  D(app, 'POST', '/waitlist/wl-1/convert', {});
  const second = D(app, 'GET', '/waitlist/wl-2').body as { position: number };
  assert.equal(second.position, 1); // moved up after wl-1 converted
});

test('withdraw removes a prospect from the queue', () => {
  const app = mkApp(); join(app);
  assert.equal((D(app, 'POST', '/waitlist/wl-1/withdraw', {}).body as { status: string }).status, 'withdrawn');
  assert.equal((D(app, 'GET', '/waitlist/wl-1').body as { position: number }).position, 0);
});

test('waitlist.manage gates writes; read_only reads; agent (OPS) manages', () => {
  const app = mkApp(); join(app);
  assert.equal(D(app, 'GET', '/waitlist', undefined, 'r').status, 200);
  assert.equal(join(app, { id: 'wl-ro' }, 'r').status, 403);
  assert.equal(join(app, { id: 'wl-bot' }, 'bot').status, 201);
});

test('the waitlist is tenant-scoped', () => {
  const app = mkApp(); join(app);
  const o2: AuthContext = { actor: 'o2', tenantId: 'other', role: 'owner' };
  const app2 = new App({ authenticator: new StaticTokenAuthenticator({ o2 }), now: () => NOW });
  app2.dispatch({ method: 'PUT', path: '/config', bearer: 'Bearer o2', body: { displayName: 'O', country: 'US' } });
  assert.equal((app2.dispatch({ method: 'GET', path: '/waitlist', bearer: 'Bearer o2', body: {} }).body as { entries: unknown[] }).entries.length, 0);
  assert.equal(app2.dispatch({ method: 'POST', path: '/waitlist/wl-1/offer', bearer: 'Bearer o2', body: {} }).status, 404);
});

test('the waitlist-demand report groups waiting prospects by floorplan', () => {
  const app = mkApp();
  join(app, { id: 'wl-1', joinedAt: '2026-07-05T00:00:00Z' });
  join(app, { id: 'wl-2', prospectName: 'Eve', joinedAt: '2026-07-06T00:00:00Z' });
  const rep = D(app, 'GET', '/reports/waitlist_demand').body as { report: { rows: Array<{ floorplan: string; waiting: number }>; kpis: Array<{ label: string; value: number }> } };
  assert.equal(rep.report.rows[0]!.floorplan, 'Two Bedroom');
  assert.equal(rep.report.rows[0]!.waiting, 2);
  assert.equal(rep.report.kpis.find((k) => k.label === 'Waiting')!.value, 2);
});

test('a full waitlist fires a demand insight', () => {
  const app = mkApp();
  for (const n of [1, 2, 3]) join(app, { id: 'wl-' + n, prospectName: 'P' + n, joinedAt: '2026-07-0' + n + 'T00:00:00Z' });
  const insights = (D(app, 'GET', '/reports/insights').body as { insights: Array<{ title: string }> }).insights;
  assert.ok(insights.some((i) => /prospect\(s\) on the waitlist/i.test(i.title)));
});

test('a waitlist entry projects to SQL and survives snapshot → rehydrate', () => {
  const app = mkApp(); join(app); D(app, 'POST', '/waitlist/wl-1/offer', {});
  const ins = projectWorld(app.snapshotWorld('mf')).find((x) => x.text.startsWith('insert into waitlist_entry '));
  assert.ok(ins);
  const b = new App({ authenticator: new StaticTokenAuthenticator({ own }), now: () => NOW });
  b.rehydrate(app.snapshotWorld('mf'));
  const e = (b.snapshotWorld('mf').waitlist ?? []).find((x) => x.id === 'wl-1')!;
  assert.equal(e.prospectName, 'Dana Reed');
  assert.equal(e.status, 'offered');
});
