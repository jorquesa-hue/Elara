// Tranche 65 — Phase 2A: rental applications + screening. The leasing step
// between "toured" and "approved" — capture the applicant, order a screening
// report through the connector framework, and decide (approve/deny). The
// decision is FCRA / Fair-Housing sensitive: policy-gated + audited, a denial
// requires an adverse-action reason and fires the adverse-action notice. 12 tests.

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
  return new App({ authenticator: new StaticTokenAuthenticator({ own, bot, ro }), units: [], now: () => NOW });
}
const D = (app: App, method: string, path: string, body?: Record<string, unknown>, token = 'own') =>
  app.dispatch({ method, path, bearer: `Bearer ${token}`, body: body ?? {} });

function seed(app: App) {
  D(app, 'PUT', '/config', { displayName: 'Greyline', country: 'US' });
  D(app, 'POST', '/units', { id: 'u-1', code: 'A-1', label: 'A1' });
  D(app, 'POST', '/leads', { id: 'ld-1', name: 'Bea Lima', source: 'website', estValueCents: 300000 });
  D(app, 'POST', '/leads/ld-1/advance', { stage: 'toured' });
}

function submit(app: App, over: Record<string, unknown> = {}) {
  return D(app, 'POST', '/applications', { id: 'app-1', applicantName: 'Bea Lima', applicantEmail: 'bea@x.com', leadId: 'ld-1', unitId: 'u-1', incomeCents: 900000, ...over });
}

test('submit an application and advance the linked lead to applied', () => {
  const app = mkApp(); seed(app);
  const res = submit(app);
  assert.equal(res.status, 201);
  assert.equal((res.body as { status: string }).status, 'submitted');
  assert.equal((D(app, 'GET', '/leads/ld-1').body as { stage: string }).stage, 'applied');
});

test('GET /applications lists and reads a single application', () => {
  const app = mkApp(); seed(app); submit(app);
  assert.equal((D(app, 'GET', '/applications').body as { applications: unknown[] }).applications.length, 1);
  assert.equal((D(app, 'GET', '/applications/app-1').body as { applicantName: string }).applicantName, 'Bea Lima');
  assert.equal(D(app, 'GET', '/applications/nope').status, 404);
});

test('screening a submitted application marks it screening; with an active integration it orders a report', () => {
  const app = mkApp(); seed(app); submit(app);
  // No screening integration yet → marks screening, ordered=false.
  const r1 = D(app, 'POST', '/applications/app-1/screen', {});
  assert.equal((r1.body as { status: string; ordered: boolean }).status, 'screening');
  assert.equal((r1.body as { ordered: boolean }).ordered, false);
  // Register an active screening integration and re-order → a credential-free command is enqueued.
  D(app, 'POST', '/integrations', { id: 'int-scr', kind: 'screening', provider: 'transunion', secretRef: 'tu-key' });
  const r2 = D(app, 'POST', '/applications/app-1/screen', {});
  assert.equal((r2.body as { ordered: boolean }).ordered, true);
  const cmds = (app.snapshotWorld('mf').connectorCommands ?? []).filter((c) => c.id === 'screen-app-1');
  assert.equal(cmds.length, 1);
  assert.equal(cmds[0]!.action, 'order_report');
  // The command payload carries NO secret.
  assert.equal(JSON.stringify(cmds[0]!.payload).includes('tu-key'), false);
});

test('record a screening result', () => {
  const app = mkApp(); seed(app); submit(app);
  const res = D(app, 'POST', '/applications/app-1/screening-result', { provider: 'transunion', reference: 'tu-1', recommendation: 'approve', creditScore: 720 });
  const scr = (res.body as { screening: { recommendation: string; creditScore: number } }).screening;
  assert.equal(scr.recommendation, 'approve');
  assert.equal(scr.creditScore, 720);
});

test('approve advances the linked lead to approved and audits the decision', () => {
  const app = mkApp(); seed(app); submit(app);
  const res = D(app, 'POST', '/applications/app-1/decide', { decision: 'approve' });
  assert.equal(res.status, 200);
  assert.equal((res.body as { status: string; decidedBy: string }).status, 'approved');
  assert.equal((res.body as { decidedBy: string }).decidedBy, 'own');
  assert.equal((D(app, 'GET', '/leads/ld-1').body as { stage: string }).stage, 'approved');
  const audit = app.snapshotWorld('mf').actionLog.filter((a) => a.action === 'application.decide');
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.effect, 'allow');
});

test('deny requires an adverse-action reason, loses the lead, and enqueues the adverse-action notice', () => {
  const app = mkApp(); seed(app); submit(app);
  // No reason → 400.
  assert.equal(D(app, 'POST', '/applications/app-1/decide', { decision: 'deny' }).status, 400);
  const res = D(app, 'POST', '/applications/app-1/decide', { decision: 'deny', reason: 'insufficient income' });
  assert.equal((res.body as { status: string; adverseActionReason: string }).status, 'denied');
  assert.equal((res.body as { adverseActionReason: string }).adverseActionReason, 'insufficient income');
  assert.equal((D(app, 'GET', '/leads/ld-1').body as { stage: string }).stage, 'lost');
  const notes = (app.snapshotWorld('mf').notifications ?? []).filter((n) => n.kind === 'adverse_action');
  assert.equal(notes.length, 1);
  assert.equal((notes[0]!.data as { reason: string }).reason, 'insufficient income');
});

test('an already-decided application cannot be re-decided', () => {
  const app = mkApp(); seed(app); submit(app);
  D(app, 'POST', '/applications/app-1/decide', { decision: 'approve' });
  assert.equal(D(app, 'POST', '/applications/app-1/decide', { decision: 'deny', reason: 'x' }).status, 409);
});

test('an invalid decision is rejected', () => {
  const app = mkApp(); seed(app); submit(app);
  assert.equal(D(app, 'POST', '/applications/app-1/decide', { decision: 'maybe' }).status, 400);
});

test('application.manage is required to submit/decide; read_only may read', () => {
  const app = mkApp(); seed(app); submit(app);
  assert.equal(D(app, 'GET', '/applications', undefined, 'ro').status, 200);
  assert.equal(D(app, 'POST', '/applications', { id: 'app-2', applicantName: 'X' }, 'ro').status, 403);
  // application.read/manage is in OPS → an agent may submit + decide.
  assert.equal(D(app, 'POST', '/applications', { id: 'app-3', applicantName: 'Cid' }, 'bot').status, 201);
  assert.equal(D(app, 'POST', '/applications/app-3/decide', { decision: 'approve' }, 'bot').status, 200);
});

test('applications are tenant-scoped — a cross-tenant read 404s', () => {
  const app = mkApp(); seed(app); submit(app);
  const other: AuthContext = { actor: 'o2', tenantId: 'other', role: 'owner' };
  const app2 = new App({ authenticator: new StaticTokenAuthenticator({ o2: other }), now: () => NOW });
  app2.dispatch({ method: 'PUT', path: '/config', bearer: 'Bearer o2', body: { displayName: 'Other', country: 'US' } });
  assert.equal(app2.dispatch({ method: 'GET', path: '/applications/app-1', bearer: 'Bearer o2', body: {} }).status, 404);
});

test('the application projects to SQL with its columns', () => {
  const app = mkApp(); seed(app); submit(app);
  D(app, 'POST', '/applications/app-1/decide', { decision: 'approve' });
  const stmts = projectWorld(app.snapshotWorld('mf'));
  const ins = stmts.find((s) => s.text.includes('insert into application'));
  assert.ok(ins, 'an application insert is projected');
  assert.ok(ins!.text.includes('applicant_name'));
  assert.ok(ins!.text.includes('$8::jsonb') || ins!.text.includes('::jsonb'), 'screening projects as jsonb');
});

test('applications survive snapshot → rehydrate', () => {
  const app = mkApp(); seed(app); submit(app);
  D(app, 'POST', '/applications/app-1/screening-result', { provider: 'transunion', reference: 'tu-1', recommendation: 'approve' });
  D(app, 'POST', '/applications/app-1/decide', { decision: 'approve' });
  const b = new App({ authenticator: new StaticTokenAuthenticator({ own }), now: () => NOW });
  b.rehydrate(app.snapshotWorld('mf'));
  const a = (b.snapshotWorld('mf').applications ?? []).find((x) => x.id === 'app-1')!;
  assert.equal(a.status, 'approved');
  assert.equal(a.decidedBy, 'own');
  assert.equal(a.screening!.recommendation, 'approve');
});
