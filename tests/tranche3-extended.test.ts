// Tranche 3 — extended: amenities, collections ladder + late fee, multi-GAAP
// accrual vs cash, occupancy/ADR/RevPAR metrics, group block pickup without
// double-booking. 5 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Ledger } from '../src/ledger.ts';
import { Billing, ACCOUNTS } from '../src/billing.ts';
import { Payments } from '../src/payments.ts';
import { AmenityCatalog, AmenityError } from '../src/amenity.ts';
import { stageFor, lateFeeCents, COLLECTION_STAGES } from '../src/collections.ts';
import { gaapView } from '../src/multigaap.ts';
import { Calendar } from '../src/agreement.ts';
import { occupancy, revenueMetrics } from '../src/metrics.ts';
import { GroupBlocks, GroupBlockError } from '../src/group-block.ts';
import { DoubleInventoryError } from '../src/agreement.ts';

test('amenity catalog charges by quantity and rejects unknown skus', () => {
  const cat = new AmenityCatalog();
  cat.add({ sku: 'clean', name: 'Extra cleaning', unitCents: 8000, currency: 'BRL' });
  const charge = cat.charge('clean', 3, 'ch-1');
  assert.equal(charge.amountCents, 24000);
  assert.equal(charge.description, 'Extra cleaning x3');
  assert.throws(() => cat.charge('nope', 1, 'ch-2'), AmenityError);
});

test('collections ladder selects the right stage and computes late fee', () => {
  assert.equal(stageFor(0), null);
  assert.equal(stageFor(1)?.action, 'remind');
  assert.equal(stageFor(10)?.action, 'late_fee');
  assert.equal(stageFor(20)?.action, 'suspend');
  assert.equal(stageFor(60)?.action, 'evict');
  // 2% of R$1000 = R$20.
  const feeStage = COLLECTION_STAGES.find((s) => s.action === 'late_fee')!;
  assert.equal(lateFeeCents(100000, feeStage.feeBps!), 2000);
  // suspend/evict are the escalation actions (human-gated by policy).
  assert.equal(stageFor(45)?.policyAction, 'collections.evict');
});

test('multi-GAAP: accrual recognizes at issue, cash recognizes on collection', () => {
  const led = new Ledger();
  const billing = new Billing(led);
  const payments = new Payments(led, billing);
  billing.issue({
    id: 'inv-g',
    agreementId: 'ag-g',
    tenantId: 't-1',
    issuedAt: '2026-07-01',
    dueAt: '2026-07-08',
    lines: [{ description: 'room', account: ACCOUNTS.roomRevenue, amountCents: 100000 }],
  });
  // Before any cash: accrual sees full revenue, cash sees none.
  assert.equal(gaapView(led, 'accrual').totalRevenueCents, 100000);
  assert.equal(gaapView(led, 'cash').totalRevenueCents, 0);
  // Collect half: cash basis recognizes half, accrual unchanged.
  payments.record({ id: 'pay-g', invoiceId: 'inv-g', amountCents: 50000, method: 'pix', receivedAt: '2026-07-02' });
  assert.equal(gaapView(led, 'accrual').totalRevenueCents, 100000);
  assert.equal(gaapView(led, 'cash').totalRevenueCents, 50000);
});

test('metrics compute occupancy, ADR and RevPAR from calendar + ledger', () => {
  const led = new Ledger();
  const billing = new Billing(led);
  const cal = new Calendar();
  const units = ['u-1', 'u-2'];
  // u-1 sold 10 of 10 window nights; u-2 idle. 50% occupancy.
  cal.hold({ id: 'h1', unitId: 'u-1', holderId: 'ag-1', start: '2026-07-01', end: '2026-07-11' });
  billing.issue({
    id: 'inv-m',
    agreementId: 'ag-1',
    tenantId: 't-1',
    issuedAt: '2026-07-01',
    dueAt: '2026-07-11',
    lines: [{ description: '10 nights', account: ACCOUNTS.roomRevenue, amountCents: 200000 }],
  });
  const occ = occupancy(cal, units, '2026-07-01', '2026-07-11');
  assert.equal(occ.availableRoomNights, 20);
  assert.equal(occ.soldRoomNights, 10);
  assert.equal(occ.occupancy, 0.5);
  const rev = revenueMetrics(led, occ);
  assert.equal(rev.adrCents, 20000); // 200000 / 10 sold nights
  assert.equal(rev.revparCents, 10000); // 200000 / 20 available nights
});

test('group block holds inventory and pickup transfers without double-booking', () => {
  const cal = new Calendar();
  const blocks = new GroupBlocks(cal);
  blocks.create({
    id: 'blk-1',
    tenantId: 't-1',
    accountName: 'Acme Corp',
    start: '2026-09-01',
    end: '2026-09-05',
    unitIds: ['u-1', 'u-2', 'u-3'],
  });
  // Block holds the inventory: a competing hold on a blocked unit fails.
  assert.throws(
    () => cal.hold({ id: 'x', unitId: 'u-1', holderId: 'other', start: '2026-09-02', end: '2026-09-03' }),
    DoubleInventoryError,
  );
  // Pickup transfers one held unit to an agreement, still exactly one active hold.
  const agHold = blocks.pickup('blk-1', 'blk-1-hold-0', 'ag-pick');
  assert.equal(agHold.holderId, 'ag-pick');
  const activeOnU1 = cal.holdsFor('u-1').filter((h) => h.status === 'active');
  assert.equal(activeOnU1.length, 1);
  assert.equal(activeOnU1[0]!.holderId, 'ag-pick');
  // Double pickup of same hold is refused.
  assert.throws(() => blocks.pickup('blk-1', 'blk-1-hold-0', 'ag-2'), GroupBlockError);
});
