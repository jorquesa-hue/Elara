// Tranche 79 — Phase 6C: package / parcel room. The front desk logs a resident's
// delivery, notifies them it arrived (via the existing outbox), and records
// pickup. A front-desk task, RBAC-only, durable. 12 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';
import { projectWorld } from '../src/persistence/project.ts';
import { parcelDaysWaiting, type Parcel } from '../src/packages.ts';

const NOW = '2026-07-13T00:00:00Z';
const own: AuthContext = { actor: 'own', tenantId: 'mf', role: 'owner' };
const fd: AuthContext = { actor: 'fd', tenantId: 'mf', role: 'front_desk' };
const ro: AuthContext = { actor: 'r', tenantId: 'mf', role: 'read_only' };
const resident: AuthContext = { actor: 'bea', tenantId: 'mf', role: 'read_only', partyId: 'pty-bea' };

const D = (app: App, method: string, path: string, body?: Record<string, unknown>, token = 'own') =>
  app.dispatch({ method, path, bearer: `Bearer ${token}`, body: body ?? {} });

function mkApp() {
  const app = new App({ authenticator: new StaticTokenAuthenticator({ own, fd, r: ro, bea: resident }), units: [], now: () => NOW });
  D(app, 'PUT', '/config', { displayName: 'Greyline', country: 'US' });
  D(app, 'POST', '/units', { id: 'u-1', code: 'A-1', label: 'Apt 101' });
  D(app, 'POST', '/agreements', { id: 'ag-1', guestId: 'Bea Lima', unitId: 'u-1', kind: 'lease', start: '2026-01-01', end: '2027-01-01', rateCents: 300000 });
  D(app, 'POST', '/agreements/ag-1/activate', {});
  D(app, 'POST', '/parties', { id: 'pty-bea', kind: 'person', displayName: 'Bea Lima', email: 'bea@x.com' });
  D(app, 'POST', '/agreements/ag-1/parties', { partyId: 'pty-bea', role: 'resident' });
  return app;
}
function log(app: App, over: Record<string, unknown> = {}, token = 'own') {
  return D(app, 'POST', '/parcels', { id: 'pcl-1', partyId: 'pty-bea', agreementId: 'ag-1', carrier: 'UPS', description: 'large box', location: 'Shelf B3', ...over }, token);
}

test('parcelDaysWaiting counts received → picked up (or → now)', () => {
  const base = { id: 'x', tenantId: 'mf', partyId: 'p', carrier: 'UPS', status: 'awaiting' } as const;
  assert.equal(parcelDaysWaiting({ ...base, receivedAt: '2026-07-06T00:00:00Z' } as Parcel, NOW), 7);
  assert.equal(parcelDaysWaiting({ ...base, status: 'picked_up', receivedAt: '2026-07-06T00:00:00Z', pickedUpAt: '2026-07-08T00:00:00Z' } as Parcel, NOW), 2);
});

test('log a parcel; the row folds recipient + unit + days waiting', () => {
  const app = mkApp();
  const r = log(app, { receivedAt: '2026-07-11T00:00:00Z' });
  assert.equal(r.status, 201);
  const p = r.body as { recipientName: string; unitLabel: string; daysWaiting: number; status: string };
  assert.equal(p.recipientName, 'Bea Lima');
  assert.equal(p.unitLabel, 'Apt 101');
  assert.equal(p.status, 'awaiting');
  assert.equal(p.daysWaiting, 2);
});

test('unknown recipient party 404; unknown agreement 404', () => {
  const app = mkApp();
  assert.equal(log(app, { id: 'p-x', partyId: 'ghost' }).status, 404);
  assert.equal(log(app, { id: 'p-y', agreementId: 'nope' }).status, 404);
});

test('notify marks the parcel notified and enqueues a package_arrival email', () => {
  const app = mkApp(); log(app);
  const r = D(app, 'POST', '/parcels/pcl-1/notify', {});
  assert.equal(r.status, 200);
  assert.equal((r.body as { status: string }).status, 'notified');
  const notes = (D(app, 'GET', '/notifications').body as { notifications: Array<{ kind: string; to: string }> }).notifications;
  assert.ok(notes.some((n) => n.kind === 'package_arrival' && n.to === 'bea@x.com'));
});

test('logging with notify:true notifies on arrival', () => {
  const app = mkApp();
  const r = log(app, { notify: true });
  assert.equal((r.body as { status: string }).status, 'notified');
});

test('pickup records who collected it and stops the clock', () => {
  const app = mkApp(); log(app);
  const r = D(app, 'POST', '/parcels/pcl-1/pickup', { pickedUpBy: 'Bea Lima' });
  assert.equal(r.status, 200);
  const p = r.body as { status: string; pickedUpBy: string };
  assert.equal(p.status, 'picked_up');
  assert.equal(p.pickedUpBy, 'Bea Lima');
  // A picked-up parcel cannot be picked up again.
  assert.equal(D(app, 'POST', '/parcels/pcl-1/pickup', {}).status, 409);
});

test('GET list sorts awaiting before picked-up', () => {
  const app = mkApp();
  log(app, { id: 'pcl-1', receivedAt: '2026-07-01T00:00:00Z' });
  log(app, { id: 'pcl-2', receivedAt: '2026-07-12T00:00:00Z' });
  D(app, 'POST', '/parcels/pcl-1/pickup', {}); // pcl-1 collected
  const rows = (D(app, 'GET', '/parcels').body as { parcels: Array<{ id: string; status: string }> }).parcels;
  assert.equal(rows[0]!.id, 'pcl-2'); // awaiting first
  assert.equal(rows[1]!.status, 'picked_up');
});

test('package.manage gates writes; read_only reads; front desk (OPS) manages', () => {
  const app = mkApp(); log(app);
  assert.equal(D(app, 'GET', '/parcels', undefined, 'r').status, 200);
  assert.equal(log(app, { id: 'pcl-ro' }, 'r').status, 403);
  assert.equal(log(app, { id: 'pcl-fd' }, 'fd').status, 201);
});

test('a resident sees only their own parcels; an operator token is 403', () => {
  const app = mkApp(); log(app);
  const body = D(app, 'GET', '/resident/parcels', undefined, 'bea').body as { parcels: Array<{ id: string }> };
  assert.equal(body.parcels.length, 1);
  assert.equal(body.parcels[0]!.id, 'pcl-1');
  assert.equal(D(app, 'GET', '/resident/parcels', undefined, 'own').status, 403);
});

test('parcels are tenant-scoped', () => {
  const app = mkApp(); log(app);
  const o2: AuthContext = { actor: 'o2', tenantId: 'other', role: 'owner' };
  const app2 = new App({ authenticator: new StaticTokenAuthenticator({ o2 }), now: () => NOW });
  app2.dispatch({ method: 'PUT', path: '/config', bearer: 'Bearer o2', body: { displayName: 'O', country: 'US' } });
  assert.equal((app2.dispatch({ method: 'GET', path: '/parcels', bearer: 'Bearer o2', body: {} }).body as { parcels: unknown[] }).parcels.length, 0);
  assert.equal(app2.dispatch({ method: 'POST', path: '/parcels/pcl-1/pickup', bearer: 'Bearer o2', body: {} }).status, 404);
});

test('the package-room report + aging insight surface unclaimed parcels', () => {
  const app = mkApp();
  log(app, { id: 'pcl-old', receivedAt: '2026-07-01T00:00:00Z' }); // 12 days waiting
  const rep = D(app, 'GET', '/reports/package_room').body as { report: { rows: Array<{ days: number }>; kpis: Array<{ label: string; value: number }> } };
  assert.equal(rep.report.rows.length, 1);
  assert.equal(rep.report.kpis.find((k) => k.label === 'Awaiting pickup')!.value, 1);
  const insights = (D(app, 'GET', '/reports/insights').body as { insights: Array<{ title: string }> }).insights;
  assert.ok(insights.some((i) => /unclaimed for 7\+ days/i.test(i.title)));
});

test('a parcel projects to SQL and survives snapshot → rehydrate', () => {
  const app = mkApp(); log(app); D(app, 'POST', '/parcels/pcl-1/notify', {});
  const ins = projectWorld(app.snapshotWorld('mf')).find((x) => x.text.startsWith('insert into parcel '));
  assert.ok(ins);
  const b = new App({ authenticator: new StaticTokenAuthenticator({ own }), now: () => NOW });
  b.rehydrate(app.snapshotWorld('mf'));
  const p = (b.snapshotWorld('mf').parcels ?? []).find((x) => x.id === 'pcl-1')!;
  assert.equal(p.carrier, 'UPS');
  assert.equal(p.status, 'notified');
});
