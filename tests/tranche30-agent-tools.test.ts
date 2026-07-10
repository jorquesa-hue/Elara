// Tranche 30 — expanded agent tool coverage. The agent can now drive the whole
// platform (not just the original core) through the same policy-gated surface
// (invariant 3): country environment, dynamic pricing, the leasing pipeline,
// e-signature, maintenance, reservations, comms, AP. Every tool routes through
// App.dispatch, so auth → RBAC → policy still runs before any effect. 10 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';
import { AgentToolCatalog } from '../src/agent/tools.ts';

const T = '2026-07-01T00:00:00Z';
const bearer = (t: string) => `Bearer ${t}`;

function setup() {
  const owner: AuthContext = { actor: 'ana', tenantId: 't-rio', role: 'owner' };
  const agent: AuthContext = { actor: 'bot', tenantId: 't-rio', role: 'agent' };
  const auth = new StaticTokenAuthenticator({ 'tok-own': owner, 'tok-agent': agent });
  const app = new App({ authenticator: auth, units: [{ id: 'u-1', tenantId: 't-rio' }, { id: 'u-2', tenantId: 't-rio' }], now: () => T });
  // Prerequisites set up by the owner (config, parties, spaces, a pricing rule).
  const D = (method: string, path: string, body?: Record<string, unknown>) => app.dispatch({ method, path, bearer: bearer('tok-own'), body });
  D('PUT', '/config', { displayName: 'Rio Ops', country: 'BR' });
  D('POST', '/parties', { id: 'p-res', kind: 'person', displayName: 'Ana Souza' });
  D('POST', '/parties', { id: 'p-vendor', kind: 'organization', displayName: 'Acme' });
  D('POST', '/spaces', { id: 's-lounge', type: 'common', code: 'L', label: 'Lounge', leasable: false });
  D('POST', '/pricing-rules', { id: 'pr-1', name: 'Studio', baseCents: 20000, weekendFactorBps: 12000, occupancyTiers: [{ minOccupancyPct: 80, factorBps: 13000 }] });
  return { app, catalog: new AgentToolCatalog(app) };
}

const inv = (catalog: AgentToolCatalog, name: string, input: Record<string, unknown> = {}) => catalog.invoke(name, input, bearer('tok-agent'));

test('the catalog now covers the whole platform surface', () => {
  const { catalog } = setup();
  const names = new Set(catalog.names());
  for (const n of ['get_environment', 'quote_stay', 'assign_party', 'adjust_rent', 'transfer_unit', 'record_move', 'create_lead', 'advance_lead', 'lose_lead', 'get_pipeline', 'prepare_signature', 'send_signature', 'raise_work_order', 'reserve_space', 'open_thread', 'send_message', 'record_bill']) {
    assert.ok(names.has(n), `missing tool: ${n}`);
  }
  assert.ok(catalog.specs().length >= 27);
});

test('all specs stay Anthropic-compatible and closed', () => {
  const { catalog } = setup();
  for (const s of catalog.specs()) {
    assert.equal(s.input_schema.additionalProperties, false);
    assert.equal(s.strict, true);
    assert.ok(s.description.length > 20);
  }
  const names = catalog.specs().map((s) => s.name);
  assert.equal(new Set(names).size, names.length); // unique
});

test('agent reads its country environment', () => {
  const { catalog } = setup();
  const r = inv(catalog, 'get_environment');
  assert.equal(r.isError, false);
  const env = JSON.parse(r.content) as { country: string; jurisdiction: string };
  assert.equal(env.country, 'BR');
  assert.equal(env.jurisdiction, 'BR');
});

test('agent quotes a stay with the demand signal', () => {
  const { catalog } = setup();
  const r = inv(catalog, 'quote_stay', { ruleId: 'pr-1', checkIn: '2026-07-01', nights: 1, occupancyPct: 85 });
  assert.equal(r.isError, false);
  assert.equal((JSON.parse(r.content) as { nightlyCents: number }).nightlyCents, 26000); // +30% occupancy
});

test('agent runs the leasing pipeline end to end', () => {
  const { catalog } = setup();
  assert.equal(inv(catalog, 'create_lead', { id: 'ld-1', name: 'Bea', estValueCents: 300000 }).status, 201);
  assert.equal(inv(catalog, 'advance_lead', { id: 'ld-1', stage: 'toured' }).status, 200);
  const pipe = JSON.parse(inv(catalog, 'get_pipeline').content) as { openCount: number; pipelineValueCents: number };
  assert.equal(pipe.openCount, 1);
  assert.equal(pipe.pipelineValueCents, 300000);
});

test('agent books, assigns a resident, and prepares + sends a lease for signature', () => {
  const { catalog } = setup();
  assert.equal(inv(catalog, 'book_stay', { id: 'ag-1', guestId: 'g-1', unitId: 'u-1', kind: 'monthly', start: '2026-07-01', end: '2027-07-01', rateCents: 300000 }).status, 201);
  assert.equal(inv(catalog, 'activate_agreement', { id: 'ag-1' }).status, 200);
  assert.equal(inv(catalog, 'assign_party', { agreementId: 'ag-1', partyId: 'p-res', role: 'resident' }).status, 201);
  assert.equal(inv(catalog, 'prepare_signature', { id: 'env-1', documentName: 'Lease', provider: 'docusign', agreementId: 'ag-1', signers: [{ name: 'Ana', email: 'ana@x.com', role: 'resident' }] }).status, 201);
  const sent = inv(catalog, 'send_signature', { id: 'env-1' });
  assert.equal(sent.isError, false);
  assert.equal((JSON.parse(sent.content) as { status: string }).status, 'sent');
});

test('agent raises a work order, reserves a common space, and messages a resident', () => {
  const { catalog } = setup();
  assert.equal(inv(catalog, 'raise_work_order', { id: 'wo-1', title: 'Leaky faucet', spaceId: 's-lounge', priority: 'high' }).status, 201);
  assert.equal(inv(catalog, 'reserve_space', { id: 'rv-1', spaceId: 's-lounge', holderPartyId: 'p-res', start: '2026-08-01T18:00:00Z', end: '2026-08-01T22:00:00Z' }).status, 201);
  assert.equal(inv(catalog, 'open_thread', { id: 'th-1', subject: 'Welcome', kind: 'resident', partyId: 'p-res' }).status, 201);
  const msg = inv(catalog, 'send_message', { threadId: 'th-1', id: 'm-1', body: 'Welcome to your new home!' });
  assert.equal(msg.isError, false);
});

test('agent records a vendor bill (AP) but cannot pay it', () => {
  const { catalog, app } = setup();
  assert.equal(inv(catalog, 'record_bill', { id: 'bill-1', payeeId: 'p-vendor', dueAt: '2026-07-20', lines: [{ description: 'parts', account: 'expenses:repairs', amountCents: 30000 }] }).status, 201);
  // paying is not an agent tool, and the agent role lacks bill.pay
  const pay = app.dispatch({ method: 'POST', path: '/bills/bill-1/pay', bearer: bearer('tok-agent'), body: { id: 'ap-1', amountCents: 30000, method: 'pix' } });
  assert.equal(pay.status, 403);
});

test('a jurisdiction-scoped policy still escalates a tool call (BR deposit cap)', () => {
  const { catalog } = setup();
  inv(catalog, 'book_stay', { id: 'ag-1', guestId: 'g-1', unitId: 'u-1', kind: 'lease', start: '2026-07-01', end: '2027-07-01', rateCents: 300000 });
  inv(catalog, 'activate_agreement', { id: 'ag-1' });
  const big = inv(catalog, 'hold_deposit', { id: 'dep-1', agreementId: 'ag-1', amountCents: 1_000_000 });
  assert.equal(big.status, 202); // escalated under BR jurisdiction, not executed
  assert.equal((JSON.parse(big.content) as { status: string }).status, 'escalated');
});

test('the agent still cannot approve its own escalations', () => {
  const { catalog } = setup();
  inv(catalog, 'book_stay', { id: 'ag-1', guestId: 'g-1', unitId: 'u-1', kind: 'lease', start: '2026-07-01', end: '2027-07-01', rateCents: 300000 });
  inv(catalog, 'activate_agreement', { id: 'ag-1' });
  const big = inv(catalog, 'hold_deposit', { id: 'dep-1', agreementId: 'ag-1', amountCents: 1_000_000 });
  const exId = (JSON.parse(big.content) as { exceptionId: string }).exceptionId;
  const approve = catalog.invoke('approve_exception', { id: exId }, bearer('tok-agent'));
  assert.equal(approve.status, 403); // an agent bearer cannot approve
});
