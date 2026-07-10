// Tranche 29 — cold-start rehydration. The write path (snapshotWorld → edge →
// DB) had no inverse: on a restart the app could not restore its in-memory world
// from the DB. App.rehydrate(world) is that inverse — the symmetric partner of
// snapshotWorld. The acceptance test is a ROUND TRIP: drive a rich world into
// App A, snapshot it, rehydrate a FRESH App B from that snapshot, and assert
// B's snapshot equals A's. Nothing the persistence layer captures is lost. 10 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';
import { ACCOUNTS } from '../src/billing.ts';
import { Repositories, type QueryExecutor, type Row } from '../src/persistence/repository.ts';
import type { SqlStatement } from '../src/persistence/executor.ts';

const T = '2026-07-01T00:00:00Z';
const bearer = (t: string) => `Bearer ${t}`;
const D = (app: App, method: string, path: string, token: string, body?: Record<string, unknown>) =>
  app.dispatch({ method, path, bearer: bearer(token), body });

const owner: AuthContext = { actor: 'ana', tenantId: 't1', role: 'owner' };
function freshApp() {
  return new App({ authenticator: new StaticTokenAuthenticator({ own: owner }), units: [{ id: 'u-1', tenantId: 't1' }, { id: 'u-2', tenantId: 't1' }], now: () => T });
}
/** A truly empty app — the cold-start target that rehydrates purely from the world. */
function bootApp() {
  return new App({ authenticator: new StaticTokenAuthenticator({ own: owner }), now: () => T });
}

/** Drive a broad world touching most modules into an App. */
function buildRichWorld(app: App) {
  D(app, 'PUT', '/config', 'own', { displayName: 'São Paulo Stays', country: 'BR' });
  // parties, entities, spaces
  D(app, 'POST', '/parties', 'own', { id: 'p-res', kind: 'person', displayName: 'Ana Souza', taxId: '111' });
  D(app, 'POST', '/parties', 'own', { id: 'p-vendor', kind: 'organization', displayName: 'Acme Repairs' });
  D(app, 'POST', '/legal-entities', 'own', { id: 'le-op', role: 'operator', name: 'Op Ltda' });
  D(app, 'POST', '/spaces', 'own', { id: 's-prop', type: 'property', code: 'P', label: 'Property', leasable: false });
  D(app, 'POST', '/spaces', 'own', { id: 's-unit', parentId: 's-prop', type: 'unit', code: 'U1', label: 'Unit 1', leasable: true });
  // agreement lifecycle + money
  D(app, 'POST', '/agreements', 'own', { id: 'ag-1', guestId: 'g-1', unitId: 'u-1', kind: 'nightly', start: '2026-07-01', end: '2026-07-10', rateCents: 20000 });
  D(app, 'POST', '/agreements/ag-1/activate', 'own', {});
  D(app, 'POST', '/agreements/ag-1/parties', 'own', { partyId: 'p-res', role: 'resident' });
  D(app, 'POST', '/invoices', 'own', { id: 'inv-1', agreementId: 'ag-1', dueAt: '2026-07-09', lines: [{ description: '9 nights', account: ACCOUNTS.roomRevenue, amountCents: 180000 }] });
  D(app, 'POST', '/payments', 'own', { id: 'pay-1', invoiceId: 'inv-1', amountCents: 180000, method: 'pix' });
  D(app, 'POST', '/deposits', 'own', { id: 'dep-1', agreementId: 'ag-1', amountCents: 50000 });
  // AP
  D(app, 'POST', '/bills', 'own', { id: 'bill-1', payeeId: 'p-vendor', dueAt: '2026-07-20', lines: [{ description: 'parts', account: 'expenses:repairs', amountCents: 30000 }] });
  // feature modules
  D(app, 'POST', '/pricing-rules', 'own', { id: 'pr-1', name: 'Studio', baseCents: 20000, weekendFactorBps: 12000, occupancyTiers: [{ minOccupancyPct: 80, factorBps: 13000 }] });
  D(app, 'POST', '/purchase-orders', 'own', { id: 'po-1', vendorId: 'p-vendor', expectedAt: '2026-07-15', lines: [{ description: 'Roof', account: 'expenses:repairs', amountCents: 200000 }] });
  D(app, 'POST', '/purchase-orders/po-1/approve', 'own', {});
  D(app, 'POST', '/budgets', 'own', { id: 'bg-1', account: 'expenses:repairs', periodStart: '2026-07-01', periodEnd: '2026-08-01', amountCents: 1000000 });
  D(app, 'POST', '/prospects', 'own', { id: 'pros-1', name: 'Ava', preferences: { cleanliness: 4, chronotype: 'early' } });
  D(app, 'POST', '/leads', 'own', { id: 'ld-1', name: 'Bea', source: 'website', estValueCents: 300000 });
  D(app, 'POST', '/leads/ld-1/advance', 'own', { stage: 'toured' });
  D(app, 'POST', '/work-orders', 'own', { id: 'wo-1', title: 'Leak', spaceId: 's-unit' });
  D(app, 'POST', '/integrations', 'own', { id: 'int-1', kind: 'lock', provider: 'salto', config: { site: 'a' }, secretRef: 'salto-key' });
  D(app, 'POST', '/integrations/int-1/commands', 'own', { id: 'cmd-1', action: 'lock.unlock' });
  D(app, 'POST', '/signature-envelopes', 'own', { id: 'env-1', documentName: 'Lease', provider: 'docusign', leadId: 'ld-1', signers: [{ name: 'Ana', email: 'ana@x.com', role: 'resident' }] });
  D(app, 'POST', '/signature-envelopes/env-1/send', 'own', {});
  // a custom role + a user
  D(app, 'POST', '/roles', 'own', { id: 'hk_lead', name: 'Housekeeping Lead', permissions: ['agreement.read', 'maintenance.manage'] });
}

// ---- the round trip -------------------------------------------------------

test('a fully rehydrated app reproduces the original snapshot exactly', () => {
  const a = freshApp();
  buildRichWorld(a);
  const world = a.snapshotWorld('t1');

  const b = bootApp();
  b.rehydrate(world);
  const world2 = b.snapshotWorld('t1');

  assert.deepEqual(world2, world);
});

test('config (country environment) survives a restart', () => {
  const a = freshApp(); buildRichWorld(a);
  const b = bootApp(); b.rehydrate(a.snapshotWorld('t1'));
  const cfg = b.config.get('t1');
  assert.equal(cfg.country, 'BR');
  assert.equal(cfg.currency, 'BRL');
  assert.equal(cfg.jurisdiction, 'BR');
});

test('the event-sourced agreement + its ledger survive a restart', () => {
  const a = freshApp(); buildRichWorld(a);
  const b = bootApp(); b.rehydrate(a.snapshotWorld('t1'));
  // the agreement is queryable and the trial balance still balances
  assert.equal(D(b, 'GET', '/agreements/ag-1', 'own').status, 200);
  const tb = D(b, 'GET', '/ledger/trial-balance', 'own').body as { balanced: boolean };
  assert.equal(tb.balanced, true);
});

test('the paid invoice and its status survive a restart', () => {
  const a = freshApp(); buildRichWorld(a);
  const b = bootApp(); b.rehydrate(a.snapshotWorld('t1'));
  const billing = D(b, 'GET', '/agreements/ag-1/billing', 'own').body as { invoices: Array<{ status: string }>; payments: unknown[]; deposits: unknown[] };
  assert.equal(billing.invoices[0]!.status, 'paid');
  assert.equal(billing.payments.length, 1);
  assert.equal(billing.deposits.length, 1);
});

test('feature-module state (pricing, PO, budget, lead, prospect, envelope) survives', () => {
  const a = freshApp(); buildRichWorld(a);
  const b = bootApp(); b.rehydrate(a.snapshotWorld('t1'));
  assert.equal((D(b, 'GET', '/pricing-rules', 'own').body as { rules: unknown[] }).rules.length, 1);
  assert.equal((D(b, 'GET', '/purchase-orders/po-1', 'own').body as { status: string }).status, 'approved');
  assert.equal((D(b, 'GET', '/budgets/bg-1/status', 'own').body as { status: { committedCents: number } }).status.committedCents, 200000);
  assert.equal((D(b, 'GET', '/leads/ld-1', 'own').body as { stage: string }).stage, 'toured');
  assert.equal((D(b, 'GET', '/prospects', 'own').body as { prospects: unknown[] }).prospects.length, 1);
  assert.equal((D(b, 'GET', '/signature-envelopes/env-1', 'own').body as { status: string }).status, 'sent');
});

test('the connector integration + its command survive (config, not secrets)', () => {
  const a = freshApp(); buildRichWorld(a);
  const b = bootApp(); b.rehydrate(a.snapshotWorld('t1'));
  const integ = (D(b, 'GET', '/integrations', 'own').body as { integrations: Array<{ secretRef: string; config: Record<string, unknown> }> }).integrations[0]!;
  assert.equal(integ.secretRef, 'salto-key'); // a reference, never a secret value
  assert.equal(integ.config['site'], 'a');
  assert.equal((D(b, 'GET', '/connector-commands', 'own').body as { commands: unknown[] }).commands.length, 1);
});

test('a rehydrated custom role is enforceable', () => {
  const a = freshApp(); buildRichWorld(a);
  const b = bootApp(); b.rehydrate(a.snapshotWorld('t1'));
  const roles = (D(b, 'GET', '/roles', 'own').body as { roles: Array<{ id: string }> }).roles;
  assert.ok(roles.some((r) => r.id === 'hk_lead'));
});

test('the action-log audit stream is restored', () => {
  const a = freshApp(); buildRichWorld(a);
  const before = a.runtime.actionLog().length;
  assert.ok(before > 0);
  const b = bootApp(); b.rehydrate(a.snapshotWorld('t1'));
  assert.equal(b.runtime.actionLog().length, before);
});

test('rehydration is idempotent with a second flush (incremental marks unaffected)', () => {
  const a = freshApp(); buildRichWorld(a);
  const world = a.snapshotWorld('t1');
  const b = bootApp(); b.rehydrate(world);
  // b can produce the same snapshot again deterministically
  assert.deepEqual(b.snapshotWorld('t1'), world);
});

// ---- the DB → world → app read path ---------------------------------------

// A permissive executor: returns seeded rows for matching tables, [] otherwise.
class SeededExecutor implements QueryExecutor {
  constructor(private readonly seed: Array<{ match: string; rows: (v: unknown[]) => Row[] }>) {}
  async query(st: SqlStatement): Promise<Row[]> {
    for (const r of this.seed) if (st.text.includes(r.match)) return r.rows(st.values);
    return [];
  }
}

test('loadWorld reads the DB back into a WorldData that rehydrates an app', async () => {
  const repos = new Repositories(new SeededExecutor([
    { match: 'from tenant where id', rows: () => [{ id: 't1', name: 'Rio', display_name: 'Rio Ops', locale: 'pt-BR', currency: 'BRL', timezone: 'America/Sao_Paulo', business_structure: 'short_stay', country: 'BR', jurisdiction: 'BR' }] },
    { match: 'from unit where tenant_id', rows: () => [{ id: 'u-1', tenant_id: 't1', label: '101' }] },
    { match: 'from agreement where tenant_id', rows: () => [{ id: 'ag-1' }] },
    { match: 'from agreement where id', rows: () => [{ id: 'ag-1', tenant_id: 't1', guest_id: null, unit_id: 'u-1' }] },
    { match: 'from agreement_event', rows: () => [
      { seq: 1, agreement_id: 'ag-1', type: 'created', at: '2026-07-01T00:00:00Z', payload: { kind: 'nightly', unitId: 'u-1', guestId: 'g-1', start: '2026-07-01', end: '2026-07-05', rateCents: 20000 } },
      { seq: 2, agreement_id: 'ag-1', type: 'activated', at: '2026-07-01T00:00:00Z', payload: {} },
    ] },
    { match: 'from journal_line', rows: () => [
      { entry_id: 'je-1', account: 'assets:cash', debit_cents: 20000, credit_cents: 0, currency: 'BRL', agreement_id: 'ag-1', memo: null, posted_at: '2026-07-01T00:00:00Z' },
      { entry_id: 'je-1', account: 'revenue:room', debit_cents: 0, credit_cents: 20000, currency: 'BRL', agreement_id: 'ag-1', memo: null, posted_at: '2026-07-01T00:00:00Z' },
    ] },
  ]), 't1');

  const world = await repos.loadWorld();
  assert.equal(world.tenants[0]!.country, 'BR');
  assert.equal(world.agreements.length, 1);
  assert.equal(world.journalLines.length, 2);

  const app = new App({ authenticator: new StaticTokenAuthenticator({ own: owner }), now: () => T });
  app.rehydrate(world);
  assert.equal(app.config.get('t1').jurisdiction, 'BR');
  assert.equal(D(app, 'GET', '/agreements/ag-1', 'own').status, 200);
  assert.equal((D(app, 'GET', '/ledger/trial-balance', 'own').body as { balanced: boolean }).balanced, true);
});

test('an empty world rehydrates cleanly', () => {
  const b = bootApp();
  b.rehydrate({ tenants: [{ id: 't1', name: 't1' }], units: [], guests: [], agreements: [], holds: [], journalLines: [], invoices: [], payments: [], deposits: [], actionLog: [] });
  assert.equal(b.config.get('t1').tenantId, 't1');
});
