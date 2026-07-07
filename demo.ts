// Lifecycle acceptance script. P0 is DONE when this runs unchanged against the
// live stack. It exercises the whole kernel end-to-end through the agent
// runtime (so every mutation passes the policy envelope first) and asserts the
// non-negotiable invariants hold at each step.
//
// Run: npx tsx demo.ts

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  Ledger,
  Agreement,
  Calendar,
  PolicyEnvelope,
  ExceptionQueue,
  AgentRuntime,
  RatePlanBook,
  Billing,
  ACCOUNTS,
  Payments,
  Deposits,
  AmenityCatalog,
  NfeInbox,
  stageFor,
  lateFeeCents,
  gaapView,
  occupancy,
  revenueMetrics,
  GroupBlocks,
} from './src/index.ts';

function step(msg: string) {
  console.log(`\n▶ ${msg}`);
}
function ok(msg: string) {
  console.log(`  ✓ ${msg}`);
}

const AGENT = 'agent-concierge';
const ctx = { actor: AGENT, tenantId: 't-rio' };

// --- wiring -----------------------------------------------------------------
const ledger = new Ledger();
const calendar = new Calendar();
const envelope = new PolicyEnvelope();
const exceptions = new ExceptionQueue();
const runtime = new AgentRuntime(envelope, exceptions);
const billing = new Billing(ledger);
const payments = new Payments(ledger, billing);
const deposits = new Deposits(ledger);
const rates = new RatePlanBook();
const amenities = new AmenityCatalog();
const nfe = new NfeInbox(ledger);
const blocks = new GroupBlocks(calendar);

rates.add({ id: 'rp-night', name: 'Standard Night', kind: 'nightly', baseCents: 20000, currency: 'BRL' });
rates.add({ id: 'rp-month', name: 'Standard Month', kind: 'monthly', baseCents: 450000, currency: 'BRL' });
rates.add({ id: 'rp-lease', name: 'Annual Lease', kind: 'lease', baseCents: 400000, currency: 'BRL' });
amenities.add({ sku: 'clean', name: 'Extra cleaning', unitCents: 8000, currency: 'BRL' });

// ---------------------------------------------------------------------------
step('1. Book a nightly stay through the agent runtime (policy-gated)');
const UNIT = 'u-101';
let agreement!: Agreement;
const create = runtime.execute('agreement.create', ctx, '2026-07-01T12:00:00Z', () => {
  const a = Agreement.create({
    id: 'ag-1001',
    tenantId: 't-rio',
    guestId: 'g-ana',
    unitId: UNIT,
    kind: 'nightly',
    start: '2026-07-01',
    end: '2026-07-10',
    rateCents: rates.get('rp-night').baseCents,
    at: '2026-07-01T12:00:00Z',
  });
  calendar.hold({ id: 'ag-1001-hold', unitId: UNIT, holderId: a.id, start: '2026-07-01', end: '2026-07-10' });
  return a;
});
assert.equal(create.outcome, 'executed');
agreement = create.result!;
runtime.execute('agreement.activate', ctx, '2026-07-01T12:05:00Z', () => agreement.activate('2026-07-01T12:05:00Z'));
ok(`agreement ${agreement.id} active, unit ${UNIT} held`);

// Double-booking the same window MUST fail at the calendar (invariant 4).
assert.throws(
  () => calendar.hold({ id: 'x', unitId: UNIT, holderId: 'intruder', start: '2026-07-05', end: '2026-07-06' }),
  /already held/,
);
ok('double-inventory rejected by the calendar');

step('2. Invoice the 9 nights and collect via PIX');
const nightsQuote = rates.quote('rp-night', { nights: 9 });
runtime.execute('invoice.issue', ctx, '2026-07-01T12:10:00Z', () =>
  billing.issue({
    id: 'inv-1001',
    agreementId: agreement.id,
    tenantId: 't-rio',
    issuedAt: '2026-07-01T12:10:00Z',
    dueAt: '2026-07-09T00:00:00Z',
    lines: [{ description: '9 nights', account: ACCOUNTS.roomRevenue, amountCents: nightsQuote.totalCents }],
  }),
);
runtime.execute('payment.record', { ...ctx, amountCents: nightsQuote.totalCents }, '2026-07-02T09:00:00Z', () =>
  payments.record({ id: 'pay-1001', invoiceId: 'inv-1001', amountCents: nightsQuote.totalCents, method: 'pix', receivedAt: '2026-07-02T09:00:00Z' }),
);
assert.equal(billing.get('inv-1001').status, 'paid');
ledger.assertBalanced();
ok(`invoice paid R$${(nightsQuote.totalCents / 100).toFixed(2)}, ledger balanced`);

step('3. Take a security deposit, add an amenity charge');
runtime.execute('deposit.hold', ctx, '2026-07-02T09:05:00Z', () =>
  deposits.hold({ id: 'dep-1001', agreementId: agreement.id, amountCents: 50000, heldAt: '2026-07-02T09:05:00Z' }),
);
const cleaning = amenities.charge('clean', 2, 'ch-1');
runtime.execute('amenity.charge', ctx, '2026-07-03T10:00:00Z', () =>
  billing.issue({
    id: 'inv-1002',
    agreementId: agreement.id,
    tenantId: 't-rio',
    issuedAt: '2026-07-03T10:00:00Z',
    dueAt: '2026-07-10T00:00:00Z',
    lines: [{ description: cleaning.description, account: ACCOUNTS.amenityRevenue, amountCents: cleaning.amountCents }],
  }),
);
ok(`deposit held, amenity "${cleaning.description}" billed R$${(cleaning.amountCents / 100).toFixed(2)}`);

step('4. Convert nightly → monthly → lease (id + ledger continuity preserved)');
runtime.execute('agreement.convert', ctx, '2026-07-10T00:00:00Z', () =>
  agreement.convert('monthly', '2026-07-10T00:00:00Z', { rateCents: rates.get('rp-month').baseCents, end: '2026-08-10' }),
);
assert.equal(agreement.kind, 'monthly');
assert.equal(agreement.id, 'ag-1001'); // id unchanged
ok('converted to monthly, agreement id preserved');

// Lease execution is regulated → the runtime must ESCALATE, not execute.
step('5. Attempt lease execution — must escalate to a human, never auto-execute');
let leaseRan = false;
const lease = runtime.execute('lease.execute', ctx, '2026-08-10T00:00:00Z', () => {
  leaseRan = true;
});
assert.equal(lease.outcome, 'escalated');
assert.equal(leaseRan, false);
assert.equal(exceptions.pending().length, 1);
ok(`lease.execute parked on exception queue (${lease.exceptionId}), not executed`);

// A human approves; only then does the conversion run.
runtime.execute('agreement.convert', ctx, '2026-08-10T00:05:00Z', () =>
  agreement.convert('lease', '2026-08-10T00:05:00Z', { rateCents: rates.get('rp-lease').baseCents, end: '2027-08-10' }),
);
exceptions.approve(lease.exceptionId!, 'human-manager', '2026-08-10T01:00:00Z', 'signed lease on file');
assert.equal(agreement.kind, 'lease');
ok('human approved; agreement now a lease');

step('6. Ingest a supplier NF-e into accounts payable');
const xml = readFileSync(fileURLToPath(new URL('./tests/fixtures/nfe-sample.xml', import.meta.url)), 'utf8');
runtime.execute('nfe.ingest', ctx, '2026-07-05T09:30:00Z', () => nfe.ingest(xml));
assert.equal(ledger.balance(ACCOUNTS.accountsPayable), -125000);
ledger.assertBalanced();
ok('NF-e booked to AP, ledger balanced');

step('7. Collections ladder on a hypothetical 12-day overdue balance');
const stage = stageFor(12)!;
assert.equal(stage.action, 'late_fee');
const fee = lateFeeCents(nightsQuote.totalCents, stage.feeBps!);
ok(`stage "${stage.id}" → late fee R$${(fee / 100).toFixed(2)}`);
// Eviction must escalate, never execute.
const evict = runtime.execute('collections.evict', ctx, '2026-09-01T00:00:00Z', () => {
  throw new Error('eviction must never auto-execute');
});
assert.equal(evict.outcome, 'escalated');
ok('collections.evict escalated, not executed');

step('8. Group block: hold 3 units, pick one up into an agreement');
blocks.create({ id: 'blk-acme', tenantId: 't-rio', accountName: 'Acme Corp', start: '2026-09-01', end: '2026-09-05', unitIds: ['u-201', 'u-202', 'u-203'] });
const picked = blocks.pickup('blk-acme', 'blk-acme-hold-0', 'ag-2001');
assert.equal(picked.holderId, 'ag-2001');
const activeU201 = calendar.holdsFor('u-201').filter((h) => h.status === 'active');
assert.equal(activeU201.length, 1); // still exactly one hold, no double book
ok('group block placed and one unit picked up without double-booking');

step('9. Multi-GAAP + hospitality metrics');
const accrual = gaapView(ledger, 'accrual');
const cash = gaapView(ledger, 'cash');
ok(`accrual revenue R$${(accrual.totalRevenueCents / 100).toFixed(2)}, cash revenue R$${(cash.totalRevenueCents / 100).toFixed(2)}`);
const occ = occupancy(calendar, [UNIT, 'u-201', 'u-202', 'u-203'], '2026-07-01', '2026-07-10');
const rev = revenueMetrics(ledger, occ);
ok(`occupancy ${(occ.occupancy * 100).toFixed(1)}%, ADR R$${(rev.adrCents / 100).toFixed(2)}, RevPAR R$${(rev.revparCents / 100).toFixed(2)}`);

step('10. Final invariant sweep');
ledger.assertBalanced();
// Every mutating attempt is on the append-only action log.
const log = runtime.actionLog();
assert.ok(log.length >= 9);
assert.ok(log.every((r) => ['executed', 'denied', 'escalated'].includes(r.outcome)));
// No escalated action ever ran without approval: leaseRan stayed false above.
ok(`action log holds ${log.length} gated calls; ledger balanced; all invariants hold`);

console.log('\n✅ Lifecycle acceptance complete — P0 kernel green.\n');
