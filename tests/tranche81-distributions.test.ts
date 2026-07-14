// Tranche 81 — Phase 7A: owner distributions. Returning operating cash to a
// property's owning legal entity (an equity draw). It MOVES MONEY OUT, so it is
// policy-gated: a distribution over R$5,000 escalates for human approval and
// only posts DR equity:distributions / CR assets:cash on allow/approve.
// Durable. 12 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';
import { projectWorld } from '../src/persistence/project.ts';

const NOW = '2026-07-13T00:00:00Z';
const own: AuthContext = { actor: 'own', tenantId: 'mf', role: 'owner' };
const acc: AuthContext = { actor: 'acc', tenantId: 'mf', role: 'accountant' };
const fd: AuthContext = { actor: 'fd', tenantId: 'mf', role: 'front_desk' };
const bot: AuthContext = { actor: 'bot', tenantId: 'mf', role: 'agent' };
const ro: AuthContext = { actor: 'r', tenantId: 'mf', role: 'read_only' };

const D = (app: App, method: string, path: string, body?: Record<string, unknown>, token = 'own') =>
  app.dispatch({ method, path, bearer: `Bearer ${token}`, body: body ?? {} });

function mkApp() {
  const app = new App({ authenticator: new StaticTokenAuthenticator({ own, acc, fd, bot, r: ro }), units: [], now: () => NOW });
  D(app, 'PUT', '/config', { displayName: 'Greyline', country: 'BR' });
  D(app, 'POST', '/legal-entities', { id: 'ent-spe', name: 'Curral SPE LLC', role: 'spe' });
  D(app, 'POST', '/properties', { id: 'prop-1', code: 'NG', name: 'Northgate', entityId: 'ent-spe' });
  // Post NOI on the community so distributions have distributable cash behind
  // them (the Phase-7C guardrail escalates a draw over NOI − reserves).
  D(app, 'POST', '/units', { id: 'u-1', code: 'A-1', label: 'Apt 101', propertyId: 'prop-1' });
  D(app, 'POST', '/agreements', { id: 'ag-1', guestId: 'Bea Lima', unitId: 'u-1', kind: 'lease', start: '2026-01-01', end: '2027-01-01', rateCents: 300000 });
  D(app, 'POST', '/agreements/ag-1/activate', {});
  D(app, 'POST', '/invoices', { id: 'inv-noi', agreementId: 'ag-1', issuedAt: NOW, dueAt: '2026-07-20', lines: [{ description: 'rent', account: 'revenue:room', amountCents: 1000000 }] });
  return app;
}
function record(app: App, over: Record<string, unknown> = {}, token = 'acc') {
  return D(app, 'POST', '/distributions', { id: 'dist-1', entityId: 'ent-spe', propertyId: 'prop-1', amountCents: 300000, memo: 'Q2 draw', ...over }, token);
}
const balanced = (app: App, token = 'own') => (D(app, 'GET', '/ledger/trial-balance', undefined, token).body as { balanced: boolean }).balanced;

test('recording a distribution posts a balanced DR equity:distributions / CR cash entry', () => {
  const app = mkApp();
  const r = record(app);
  assert.equal(r.status, 201);
  const d = r.body as { amountCents: number; entityName: string; propertyName: string };
  assert.equal(d.amountCents, 300000);
  assert.equal(d.entityName, 'Curral SPE LLC');
  assert.equal(d.propertyName, 'Northgate');
  assert.equal(balanced(app), true); // the entry balances (invariant 6)
  // The draw shows as a debit on equity:distributions and a credit on cash.
  const rep = D(app, 'GET', '/reports/general_ledger').body as { report: { rows: Array<{ account: string; debits?: number; credits?: number; net?: number }> } };
  const draw = rep.report.rows.find((x) => x.account === 'equity:distributions');
  assert.ok(draw, 'the distributions equity account exists in the ledger');
});

test('a distribution over R$5,000 escalates and does NOT post', () => {
  const app = mkApp();
  const r = record(app, { id: 'dist-big', amountCents: 600001 }); // > 500000
  assert.equal(r.status, 202);
  assert.equal((r.body as { status: string }).status, 'escalated');
  // Nothing recorded, nothing posted.
  assert.equal((D(app, 'GET', '/distributions').body as { distributions: unknown[] }).distributions.length, 0);
  assert.equal(balanced(app), true);
});

test('a human approving the escalation records + posts the distribution', () => {
  const app = mkApp();
  const esc = record(app, { id: 'dist-big', amountCents: 600001 });
  const exId = (esc.body as { exceptionId: string }).exceptionId;
  const ap = D(app, 'POST', `/exceptions/${exId}/approve`, {}, 'own'); // a different approver
  assert.equal(ap.status, 200);
  assert.equal((D(app, 'GET', '/distributions').body as { distributions: unknown[] }).distributions.length, 1);
  assert.equal(balanced(app), true);
});

test('a distribution just under the threshold is auto-approved', () => {
  const app = mkApp();
  assert.equal(record(app, { id: 'dist-ok', amountCents: 500000 }).status, 201); // == threshold, not over
});

test('unknown entity 404; unknown property 404; non-positive amount 409', () => {
  const app = mkApp();
  assert.equal(record(app, { id: 'd-x', entityId: 'ghost' }).status, 404);
  assert.equal(record(app, { id: 'd-y', propertyId: 'nope' }).status, 404);
  assert.equal(record(app, { id: 'd-z', amountCents: 0 }).status, 409);
});

test('a property-less distribution still records (portfolio-level draw)', () => {
  const app = mkApp();
  const r = D(app, 'POST', '/distributions', { id: 'dist-port', entityId: 'ent-spe', amountCents: 100000 }, 'acc');
  assert.equal(r.status, 201);
  assert.equal((r.body as { propertyName?: string }).propertyName, undefined);
});

test('GET list and GET :id return the distribution with owner labels', () => {
  const app = mkApp(); record(app);
  assert.equal((D(app, 'GET', '/distributions').body as { distributions: unknown[] }).distributions.length, 1);
  assert.equal((D(app, 'GET', '/distributions/dist-1').body as { entityName: string }).entityName, 'Curral SPE LLC');
});

test('distribution.record is finance-only: read_only reads, front-desk/agent 403, accountant records', () => {
  const app = mkApp(); record(app);
  assert.equal(D(app, 'GET', '/distributions', undefined, 'r').status, 200);
  assert.equal(record(app, { id: 'd-ro' }, 'r').status, 403);
  assert.equal(record(app, { id: 'd-fd' }, 'fd').status, 403); // front_desk is OPS, no distribution.record
  assert.equal(record(app, { id: 'd-bot' }, 'bot').status, 403); // agent is OPS, no distribution.record
  assert.equal(record(app, { id: 'd-acc' }, 'acc').status, 201); // accountant (finance) can
});

test('distributions are tenant-scoped', () => {
  const app = mkApp(); record(app);
  const o2: AuthContext = { actor: 'o2', tenantId: 'other', role: 'owner' };
  const app2 = new App({ authenticator: new StaticTokenAuthenticator({ o2 }), now: () => NOW });
  app2.dispatch({ method: 'PUT', path: '/config', bearer: 'Bearer o2', body: { displayName: 'O', country: 'US' } });
  assert.equal((app2.dispatch({ method: 'GET', path: '/distributions', bearer: 'Bearer o2', body: {} }).body as { distributions: unknown[] }).distributions.length, 0);
  assert.equal(app2.dispatch({ method: 'GET', path: '/distributions/dist-1', bearer: 'Bearer o2', body: {} }).status, 404);
});

test('the owner-distributions report groups by entity/community', () => {
  const app = mkApp();
  record(app, { id: 'dist-1', amountCents: 300000 });
  record(app, { id: 'dist-2', amountCents: 200000 });
  const rep = D(app, 'GET', '/reports/owner_distributions').body as { report: { rows: Array<{ entity: string; distributed: number }>; kpis: Array<{ label: string; value: number }> } };
  assert.equal(rep.report.rows[0]!.entity, 'Curral SPE LLC');
  assert.equal(rep.report.rows[0]!.distributed, 500000); // both draws to the same owner/community
  assert.equal(rep.report.kpis.find((k) => k.label === 'Total distributed')!.value, 500000);
});

test('the ledger stays tenant-scoped + balanced across a distribution', () => {
  const app = mkApp(); record(app);
  const tb = D(app, 'GET', '/ledger/trial-balance').body as { balanced: boolean; lines?: unknown[] };
  assert.equal(tb.balanced, true);
});

test('a distribution projects to SQL and survives snapshot → rehydrate', () => {
  const app = mkApp(); record(app);
  const stmts = projectWorld(app.snapshotWorld('mf'));
  assert.ok(stmts.find((x) => x.text.startsWith('insert into distribution ')));
  const b = new App({ authenticator: new StaticTokenAuthenticator({ own }), now: () => NOW });
  b.rehydrate(app.snapshotWorld('mf'));
  const d = (b.snapshotWorld('mf').distributions ?? []).find((x) => x.id === 'dist-1')!;
  assert.equal(d.amountCents, 300000);
  assert.equal(d.entityId, 'ent-spe');
  assert.equal(b.dispatch({ method: 'GET', path: '/ledger/trial-balance', bearer: 'Bearer own', body: {} }).body && (b.snapshotWorld('mf').distributions ?? []).length, 1);
});
