// Tranche 25 — CRM & pipeline KPIs (#20). Leasing is a sales funnel: a lead is
// new → toured → applied → approved → signed, or lost along the way. A pure,
// zero-dep tracker + the KPI rollups a dashboard needs (funnel counts, open
// pipeline value, win rate). Config/reporting only — the real lease execution
// still runs through the agreement + lease.execute policy path. 12 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Crm, crmKpis, CrmError, type Lead } from '../src/crm.ts';
import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';

const T = '2026-07-01T00:00:00Z';
const bearer = (t: string) => `Bearer ${t}`;
const D = (app: App, method: string, path: string, token: string, body?: Record<string, unknown>) =>
  app.dispatch({ method, path, bearer: bearer(token), body });

// ---- pure kernel ---------------------------------------------------------

test('a new lead starts in "new" and advances forward through the funnel', () => {
  const crm = new Crm();
  const l = crm.createLead({ id: 'l1', tenantId: 't1', name: 'Ana', estValueCents: 300000, createdAt: T });
  assert.equal(l.stage, 'new');
  assert.equal(crm.advance('l1', 'toured', T).stage, 'toured');
  assert.equal(crm.advance('l1', 'signed', T).stage, 'signed'); // skipping forward is allowed
  assert.ok(crm.get('l1').stageAt['signed']);
});

test('a lead cannot move backward or advance once closed', () => {
  const crm = new Crm();
  crm.createLead({ id: 'l1', tenantId: 't1', name: 'Ana', createdAt: T });
  crm.advance('l1', 'applied', T);
  assert.throws(() => crm.advance('l1', 'toured', T), CrmError); // backward
  crm.advance('l1', 'signed', T);
  assert.throws(() => crm.advance('l1', 'approved', T), CrmError); // closed
});

test('lose() drops a lead with a reason; it is then closed', () => {
  const crm = new Crm();
  crm.createLead({ id: 'l1', tenantId: 't1', name: 'Ana', createdAt: T });
  const lost = crm.lose('l1', 'chose another place', T);
  assert.equal(lost.stage, 'lost');
  assert.equal(lost.lostReason, 'chose another place');
  assert.throws(() => crm.lose('l1', 'again', T), CrmError);
});

test('createLead validation', () => {
  const crm = new Crm();
  crm.createLead({ id: 'l1', tenantId: 't1', name: 'Ana', createdAt: T });
  assert.throws(() => crm.createLead({ id: 'l1', tenantId: 't1', name: 'Dup', createdAt: T }), CrmError);
  assert.throws(() => crm.createLead({ id: 'l2', tenantId: 't1', name: '', createdAt: T }), CrmError);
  assert.throws(() => crm.createLead({ id: 'l3', tenantId: 't1', name: 'X', estValueCents: -1, createdAt: T }), CrmError);
});

test('crmKpis folds the funnel: pipeline value, won value, conversion', () => {
  const mk = (id: string, stage: Lead['stage'], est: number): Lead => ({ id, tenantId: 't1', name: id, stage, estValueCents: est, createdAt: T, updatedAt: T, stageAt: {} });
  const k = crmKpis([
    mk('a', 'new', 100000),
    mk('b', 'applied', 200000),
    mk('c', 'signed', 300000),
    mk('d', 'lost', 400000),
  ]);
  assert.equal(k.total, 4);
  assert.equal(k.openCount, 2); // new + applied
  assert.equal(k.wonCount, 1);
  assert.equal(k.lostCount, 1);
  assert.equal(k.pipelineValueCents, 300000); // 100000 + 200000 open
  assert.equal(k.wonValueCents, 300000);
  assert.equal(k.conversionPct, 50); // 1 won / (1 won + 1 lost)
  assert.equal(k.byStage.applied, 1);
});

test('crmKpis on an empty pipeline is all zeros', () => {
  const k = crmKpis([]);
  assert.equal(k.total, 0);
  assert.equal(k.conversionPct, 0);
  assert.equal(k.pipelineValueCents, 0);
});

// ---- through the Public API ----------------------------------------------

function makeApp() {
  const owner: AuthContext = { actor: 'ana', tenantId: 't1', role: 'owner' };
  const agent: AuthContext = { actor: 'bot', tenantId: 't1', role: 'agent' };
  const reader: AuthContext = { actor: 'aud', tenantId: 't1', role: 'read_only' };
  const acct: AuthContext = { actor: 'fin', tenantId: 't1', role: 'accountant' };
  const auth = new StaticTokenAuthenticator({ own: owner, bot: agent, ro: reader, fin: acct });
  return new App({ authenticator: auth, now: () => T });
}

test('API: create a lead, advance it, and read the funnel summary', () => {
  const app = makeApp();
  assert.equal(D(app, 'POST', '/leads', 'own', { id: 'l1', name: 'Ana Souza', source: 'website', estValueCents: 300000 }).status, 201);
  D(app, 'POST', '/leads', 'own', { id: 'l2', name: 'Bea Lima', estValueCents: 250000 });
  assert.equal((D(app, 'POST', '/leads/l1/advance', 'own', { stage: 'toured' }).body as { stage: string }).stage, 'toured');
  D(app, 'POST', '/leads/l2/lose', 'own', { reason: 'budget' });
  const s = D(app, 'GET', '/crm/summary', 'own').body as { openCount: number; lostCount: number; pipelineValueCents: number };
  assert.equal(s.openCount, 1);
  assert.equal(s.lostCount, 1);
  assert.equal(s.pipelineValueCents, 300000);
});

test('API: advancing an unknown lead is 404; a bad backward move is 409', () => {
  const app = makeApp();
  D(app, 'POST', '/leads', 'own', { id: 'l1', name: 'Ana' });
  D(app, 'POST', '/leads/l1/advance', 'own', { stage: 'approved' });
  assert.equal(D(app, 'POST', '/leads/nope/advance', 'own', { stage: 'toured' }).status, 404);
  assert.equal(D(app, 'POST', '/leads/l1/advance', 'own', { stage: 'toured' }).status, 409); // backward
});

test('API: the agent (sales) can manage leads; read_only cannot', () => {
  const app = makeApp();
  assert.equal(D(app, 'POST', '/leads', 'bot', { id: 'l1', name: 'Ana' }).status, 201); // crm.manage in OPS
  assert.equal(D(app, 'GET', '/leads', 'ro').status, 200);
  assert.equal(D(app, 'POST', '/leads', 'ro', { id: 'l2', name: 'X' }).status, 403);
});

test('API: finance (accountant) has no CRM access by default', () => {
  const app = makeApp();
  assert.equal(D(app, 'GET', '/leads', 'fin').status, 403);
});

test('API: a lead can link to a party; unknown party is 404', () => {
  const app = makeApp();
  D(app, 'POST', '/parties', 'own', { id: 'p1', kind: 'person', displayName: 'Ana Souza' });
  assert.equal(D(app, 'POST', '/leads', 'own', { id: 'l1', name: 'Ana', partyId: 'p1' }).status, 201);
  assert.equal(D(app, 'POST', '/leads', 'own', { id: 'l2', name: 'Bea', partyId: 'nope' }).status, 404);
});

test('API: tenants are isolated', () => {
  const owner2: AuthContext = { actor: 'x', tenantId: 't2', role: 'owner' };
  const auth = new StaticTokenAuthenticator({ own: { actor: 'ana', tenantId: 't1', role: 'owner' }, sp: owner2 });
  const app = new App({ authenticator: auth, now: () => T });
  D(app, 'POST', '/leads', 'own', { id: 'l1', name: 'Ana' });
  assert.equal(D(app, 'GET', '/leads/l1', 'sp').status, 404);
  assert.equal((D(app, 'GET', '/leads', 'sp').body as { leads: unknown[] }).leads.length, 0);
});
