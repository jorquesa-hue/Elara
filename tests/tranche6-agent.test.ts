// Tranche 6 — agent tool layer: specs are well-formed and Anthropic-compatible,
// invocations route through the policy-gated API, escalations surface without
// executing, agents cannot approve them, and unknown tools error cleanly. 5 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';
import { AgentToolCatalog } from '../src/agent/tools.ts';

const T = '2026-07-01T00:00:00Z';

function setup() {
  const agent: AuthContext = { actor: 'agent-rio', tenantId: 't-rio', role: 'agent' };
  const staff: AuthContext = { actor: 'mgr-rio', tenantId: 't-rio', role: 'staff' };
  const auth = new StaticTokenAuthenticator({ 'tok-agent': agent, 'tok-staff': staff });
  const app = new App({
    authenticator: auth,
    units: [{ id: 'u-1', tenantId: 't-rio' }],
    now: () => T,
  });
  return { app, catalog: new AgentToolCatalog(app) };
}

test('specs are Anthropic tool-use compatible and closed', () => {
  const { catalog } = setup();
  const specs = catalog.specs();
  assert.ok(specs.length >= 10);
  for (const s of specs) {
    assert.equal(typeof s.name, 'string');
    assert.ok(s.description.length > 20); // prescriptive, not a stub
    assert.equal(s.input_schema.type, 'object');
    assert.equal(s.input_schema.additionalProperties, false); // strict-mode requirement
    assert.equal(s.strict, true);
    assert.ok(Array.isArray(s.input_schema.required));
  }
  // Names are unique.
  const names = specs.map((s) => s.name);
  assert.equal(new Set(names).size, names.length);
});

test('tool invocations route through the policy-gated API (allow path)', () => {
  const { catalog } = setup();
  const book = catalog.invoke(
    'book_stay',
    { id: 'ag-1', guestId: 'g-1', unitId: 'u-1', kind: 'nightly', start: '2026-07-01', end: '2026-07-10', rateCents: 20000 },
    'tok-agent',
  );
  assert.equal(book.isError, false);
  assert.equal(book.status, 201);

  const activate = catalog.invoke('activate_agreement', { id: 'ag-1' }, 'tok-agent');
  assert.equal(activate.isError, false);
  assert.equal(JSON.parse(activate.content).status, 'active');

  const tb = catalog.invoke('get_trial_balance', {}, 'tok-agent');
  assert.equal(JSON.parse(tb.content).balanced, true);
});

test('unauthenticated / unknown-tool calls come back as readable tool errors', () => {
  const { catalog } = setup();
  const noAuth = catalog.invoke('get_trial_balance', {}, 'bad-token');
  assert.equal(noAuth.isError, true);
  assert.equal(noAuth.status, 401);

  const unknown = catalog.invoke('drop_database', {}, 'tok-agent');
  assert.equal(unknown.isError, true);
  assert.equal(unknown.status, 404);
  assert.match(JSON.parse(unknown.content).error, /unknown tool/);
});

test('double-book surfaces to the agent as an error tool result', () => {
  const { catalog } = setup();
  const base = { guestId: 'g-1', unitId: 'u-1', kind: 'nightly', start: '2026-07-01', end: '2026-07-10', rateCents: 20000 };
  assert.equal(catalog.invoke('book_stay', { id: 'ag-1', ...base }, 'tok-agent').isError, false);
  const clash = catalog.invoke('book_stay', { id: 'ag-2', ...base }, 'tok-agent');
  assert.equal(clash.isError, true);
  assert.equal(clash.status, 409); // calendar EXCLUDE surfaced (invariant 4)
});

test('escalations are visible but an agent cannot approve them', () => {
  const { app, catalog } = setup();
  // Drive an escalating action through the runtime to park one on the queue.
  const esc = app.runtime.execute('lease.execute', { actor: 'agent-rio', tenantId: 't-rio' }, T, () => 'LEASED');
  assert.equal(esc.outcome, 'escalated');

  const list = catalog.invoke('list_exceptions', {}, 'tok-agent');
  assert.equal(JSON.parse(list.content).pending.length, 1);

  // Agent bearer → refused.
  const denied = catalog.invoke('approve_exception', { id: esc.exceptionId }, 'tok-agent');
  assert.equal(denied.isError, true);
  assert.equal(denied.status, 403);

  // Staff bearer → approved, deferred op runs.
  const approved = catalog.invoke('approve_exception', { id: esc.exceptionId }, 'tok-staff');
  assert.equal(approved.isError, false);
  assert.equal(JSON.parse(approved.content).result, 'LEASED');
});
