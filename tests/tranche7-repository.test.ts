// Tranche 7 — read layer: event-sourced rehydration reproduces the fold, the
// read repository reconstructs agreements + trial balance from rows, and tenant
// scoping is applied. 4 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Agreement } from '../src/agreement.ts';
import { Repositories, FakeQueryExecutor } from '../src/persistence/repository.ts';

const META = { id: 'ag-1', tenantId: 't-1', guestId: 'g-1', unitId: 'u-1' };

function eventStream() {
  // The exact rows projectWorld would have written for a nightly→monthly stay.
  return [
    { seq: 1, agreement_id: 'ag-1', type: 'created', at: '2026-07-01T00:00:00Z', payload: { kind: 'nightly', start: '2026-07-01', end: '2026-07-10', rateCents: 20000, currency: 'BRL' } },
    { seq: 2, agreement_id: 'ag-1', type: 'activated', at: '2026-07-01T00:05:00Z', payload: {} },
    { seq: 3, agreement_id: 'ag-1', type: 'converted', at: '2026-07-10T00:00:00Z', payload: { from: 'nightly', to: 'monthly', rateCents: 450000, end: '2026-08-10' } },
  ];
}

test('rehydrate reproduces the fold from the event stream', () => {
  const events = eventStream().map((r) => ({
    seq: r.seq,
    agreementId: r.agreement_id,
    type: r.type as never,
    at: r.at,
    payload: r.payload,
  }));
  const a = Agreement.rehydrate(META, events);
  assert.equal(a.id, 'ag-1');
  assert.equal(a.kind, 'monthly'); // last conversion wins
  assert.equal(a.status, 'active');
  assert.equal(a.rateCents, 450000);
  assert.equal(a.period.end, '2026-08-10');
  assert.deepEqual(a.history.map((e) => e.type), ['created', 'activated', 'converted']);
});

test('rehydrate rejects a stream that does not start with created', () => {
  assert.throws(
    () => Agreement.rehydrate(META, [{ seq: 1, agreementId: 'ag-1', type: 'activated', at: 'x', payload: {} }]),
    /must start with 'created'/,
  );
});

test('repository loads and rehydrates an agreement, out-of-order rows tolerated', async () => {
  const shuffled = [eventStream()[2], eventStream()[0], eventStream()[1]]; // seq 3,1,2
  const q = new FakeQueryExecutor([
    { match: 'from agreement where id', rows: () => [{ id: 'ag-1', tenant_id: 't-1', guest_id: 'g-1', unit_id: 'u-1' }] },
    { match: 'from agreement_event', rows: () => shuffled as never },
  ]);
  const repo = new Repositories(q, 't-1');
  const a = (await repo.loadAgreement('ag-1'))!;
  assert.equal(a.kind, 'monthly'); // reconstructed in seq order despite shuffled rows
  assert.equal(a.rateCents, 450000);
});

test('repository computes tenant-scoped trial balance and enforces tenant on load', async () => {
  const q = new FakeQueryExecutor([
    // Wrong-tenant agreement lookup returns nothing → null.
    { match: 'from agreement where id', rows: (v) => (v[1] === 't-1' ? [{ id: 'ag-1', tenant_id: 't-1', guest_id: 'g-1', unit_id: 'u-1' }] : []) },
    { match: 'from agreement_event', rows: () => eventStream() as never },
    {
      match: 'from journal_line',
      rows: () => [
        { account: 'assets:cash', net: 180000 },
        { account: 'revenue:room', net: -180000 },
      ],
    },
  ]);
  const mine = new Repositories(q, 't-1');
  const tb = await mine.loadTrialBalance();
  assert.equal(tb.balances['assets:cash'], 180000);
  assert.equal(tb.net, 0);
  assert.equal(tb.balanced, true);

  const other = new Repositories(q, 't-other');
  assert.equal(await other.loadAgreement('ag-1'), null); // tenant scoping: not visible
});
