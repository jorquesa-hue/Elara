// Tranche 83 — Phase 7C: distributable-NOI guardrail. Distributable cash for an
// owning entity = NOI − reserves − already-distributed. A distribution that would
// exceed it (return capital the community hasn't earned) escalates for human
// approval — even under the R$5k threshold. 10 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';

const NOW = '2026-07-13T00:00:00Z';
const own: AuthContext = { actor: 'own', tenantId: 'mf', role: 'owner' };
const acc: AuthContext = { actor: 'acc', tenantId: 'mf', role: 'accountant' };
const ownerA: AuthContext = { actor: 'oa', tenantId: 'mf', role: 'read_only', entityId: 'ent-a' };

const D = (app: App, method: string, path: string, body?: Record<string, unknown>, token = 'own') =>
  app.dispatch({ method, path, bearer: `Bearer ${token}`, body: body ?? {} });

// NOI = `noi` cents on the entity's one community (a single revenue invoice).
function mkApp(noi = 300000) {
  const app = new App({ authenticator: new StaticTokenAuthenticator({ own, acc, oa: ownerA }), units: [], now: () => NOW });
  D(app, 'PUT', '/config', { displayName: 'Greyline', country: 'US' });
  D(app, 'POST', '/legal-entities', { id: 'ent-a', name: 'Northgate SPE LLC', role: 'spe' });
  D(app, 'POST', '/properties', { id: 'prop-a', code: 'NG', name: 'Northgate', entityId: 'ent-a' });
  D(app, 'POST', '/units', { id: 'u-a', code: 'A-1', label: 'Apt 101', propertyId: 'prop-a' });
  D(app, 'POST', '/agreements', { id: 'ag-a', guestId: 'Bea Lima', unitId: 'u-a', kind: 'lease', start: '2026-01-01', end: '2027-01-01', rateCents: 300000 });
  D(app, 'POST', '/agreements/ag-a/activate', {});
  D(app, 'POST', '/invoices', { id: 'inv-a', agreementId: 'ag-a', issuedAt: NOW, dueAt: '2026-07-20', lines: [{ description: 'rent', account: 'revenue:room', amountCents: noi }] });
  return app;
}
const dist = (app: App, over: Record<string, unknown> = {}) =>
  D(app, 'POST', '/distributions', { id: 'd-1', entityId: 'ent-a', propertyId: 'prop-a', amountCents: 100000, ...over }, 'acc');

test('the distributable preview returns NOI, distributed and distributable', () => {
  const app = mkApp(300000);
  const p = D(app, 'GET', '/distributions/distributable', { entityId: 'ent-a' }).body as { noiCents: number; distributedCents: number; distributableCents: number };
  assert.equal(p.noiCents, 300000);
  assert.equal(p.distributedCents, 0);
  assert.equal(p.distributableCents, 300000);
});

test('a distribution within distributable is auto-approved', () => {
  const app = mkApp(300000);
  assert.equal(dist(app, { amountCents: 250000 }).status, 201);
});

test('a distribution OVER distributable escalates — even under the R$5k threshold', () => {
  const app = mkApp(300000);
  const r = dist(app, { amountCents: 400000 }); // 400000 < 500000 (not "large") but > 300000 distributable
  assert.equal(r.status, 202);
  assert.equal((r.body as { status: string }).status, 'escalated');
  // Nothing recorded until a human approves.
  assert.equal((D(app, 'GET', '/distributions').body as { distributions: unknown[] }).distributions.length, 0);
});

test('a reserve reduces distributable, so an otherwise-fine draw escalates', () => {
  const app = mkApp(300000);
  // reserve 200000 -> distributable 100000; a 150000 draw now escalates.
  const preview = D(app, 'GET', '/distributions/distributable', { entityId: 'ent-a', reserveCents: 200000 }).body as { distributableCents: number };
  assert.equal(preview.distributableCents, 100000);
  assert.equal(dist(app, { amountCents: 150000, reserveCents: 200000 }).status, 202);
  assert.equal(dist(app, { id: 'd-ok', amountCents: 80000, reserveCents: 200000 }).status, 201); // within the reserved distributable
});

test('a human approving records the over-distribution', () => {
  const app = mkApp(300000);
  const esc = dist(app, { amountCents: 400000 });
  const exId = (esc.body as { exceptionId: string }).exceptionId;
  assert.equal(D(app, 'POST', `/exceptions/${exId}/approve`, {}, 'own').status, 200);
  assert.equal((D(app, 'GET', '/distributions').body as { distributions: unknown[] }).distributions.length, 1);
});

test('distributable drops as distributions are recorded', () => {
  const app = mkApp(300000);
  dist(app, { id: 'd-1', amountCents: 100000 });
  const p = D(app, 'GET', '/distributions/distributable', { entityId: 'ent-a' }).body as { distributedCents: number; distributableCents: number };
  assert.equal(p.distributedCents, 100000);
  assert.equal(p.distributableCents, 200000); // 300000 - 100000
});

test('distributable is floored at 0 when the community operates at a loss', () => {
  const app = mkApp(300000);
  // A big expense pushes NOI negative.
  D(app, 'POST', '/parties', { id: 'v-1', kind: 'organization', displayName: 'Acme' });
  D(app, 'POST', '/bills', { id: 'bill-a', payeeId: 'v-1', propertyId: 'prop-a', dueAt: '2026-07-20', lines: [{ description: 'roof', account: 'expense:repairs', amountCents: 500000 }] });
  const p = D(app, 'GET', '/distributions/distributable', { entityId: 'ent-a' }).body as { noiCents: number; distributableCents: number };
  assert.equal(p.noiCents, -200000); // 300000 revenue - 500000 expense
  assert.equal(p.distributableCents, 0); // floored — any distribution now escalates
  assert.equal(dist(app, { amountCents: 10000 }).status, 202);
});

test('the owner home surfaces distributable headroom', () => {
  const app = mkApp(300000);
  dist(app, { id: 'd-1', amountCents: 100000 });
  const home = D(app, 'GET', '/owner/home', undefined, 'oa').body as { distributableCents: number; totalNoiCents: number };
  assert.equal(home.totalNoiCents, 300000);
  assert.equal(home.distributableCents, 200000);
});

test('the distributable preview 404s for an unknown entity', () => {
  const app = mkApp();
  assert.equal(D(app, 'GET', '/distributions/distributable', { entityId: 'ghost' }).status, 404);
});

test("the 'distributable' path is not captured as a distribution id", () => {
  const app = mkApp();
  // GET /distributions/distributable must hit the preview, not the /:id handler
  // (which would 404 'distributable' as an unknown distribution).
  const r = D(app, 'GET', '/distributions/distributable', { entityId: 'ent-a' });
  assert.equal(r.status, 200);
  assert.ok('distributableCents' in (r.body as Record<string, unknown>));
});
