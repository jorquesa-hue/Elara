// Live lifecycle acceptance. Runs the same kernel lifecycle as demo.ts, then
// PERSISTS the accumulated state to Postgres through the persistence adapter.
// This is the "against the live stack" half of the P0 acceptance criterion.
//
//   DATABASE_URL=postgres://…  npx tsx demo-live.ts   # commits to that DB
//   npx tsx demo-live.ts                              # prints a runnable script
//
// With no DATABASE_URL it records the batch and emits SQL to stdout, so the
// same statements can be applied via the DB tooling (e.g. a transaction that
// SET CONSTRAINTS ALL IMMEDIATE to force the deferred balance check, verifies,
// then ROLLBACKs to leave the DB clean).

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
  projectWorld,
  renderScript,
  RecordingExecutor,
  PgExecutor,
  type WorldData,
  type SqlExecutor,
} from './src/index.ts';

const TENANT = { id: 'demo-live', name: 'Demo Live Ops' };
const UNIT = { id: 'dl-u-1', tenantId: TENANT.id, label: '101' };
const GUEST = { id: 'dl-g-1', tenantId: TENANT.id, fullName: 'Ana Souza' };
const ctx = { actor: 'agent-concierge', tenantId: TENANT.id };

// --- run the lifecycle in memory -------------------------------------------
const ledger = new Ledger();
const calendar = new Calendar();
const runtime = new AgentRuntime(new PolicyEnvelope(), new ExceptionQueue());
const billing = new Billing(ledger);
const payments = new Payments(ledger, billing);
const deposits = new Deposits(ledger);
const rates = new RatePlanBook();
rates.add({ id: 'dl-rp-night', name: 'Standard Night', kind: 'nightly', baseCents: 20000, currency: 'BRL' });
rates.add({ id: 'dl-rp-month', name: 'Standard Month', kind: 'monthly', baseCents: 450000, currency: 'BRL' });

const ag = Agreement.create({
  id: 'dl-ag-1',
  tenantId: TENANT.id,
  guestId: GUEST.id,
  unitId: UNIT.id,
  kind: 'nightly',
  start: '2026-07-01',
  end: '2026-07-10',
  rateCents: rates.get('dl-rp-night').baseCents,
  at: '2026-07-01T12:00:00Z',
});
runtime.execute('agreement.create', ctx, '2026-07-01T12:00:00Z', () => ag);
runtime.execute('agreement.activate', ctx, '2026-07-01T12:05:00Z', () => ag.activate('2026-07-01T12:05:00Z'));
calendar.hold({ id: 'dl-ag-1-hold', unitId: UNIT.id, holderId: ag.id, start: '2026-07-01', end: '2026-07-10' });

const quote = rates.quote('dl-rp-night', { nights: 9 });
runtime.execute('invoice.issue', ctx, '2026-07-01T12:10:00Z', () =>
  billing.issue({
    id: 'dl-inv-1',
    agreementId: ag.id,
    tenantId: TENANT.id,
    issuedAt: '2026-07-01T12:10:00Z',
    dueAt: '2026-07-09T00:00:00Z',
    lines: [{ description: '9 nights', account: ACCOUNTS.roomRevenue, amountCents: quote.totalCents }],
  }),
);
runtime.execute('payment.record', { ...ctx, amountCents: quote.totalCents }, '2026-07-02T09:00:00Z', () =>
  payments.record({ id: 'dl-pay-1', invoiceId: 'dl-inv-1', amountCents: quote.totalCents, method: 'pix', receivedAt: '2026-07-02T09:00:00Z' }),
);
runtime.execute('deposit.hold', ctx, '2026-07-02T09:05:00Z', () =>
  deposits.hold({ id: 'dl-dep-1', agreementId: ag.id, amountCents: 50000, heldAt: '2026-07-02T09:05:00Z' }),
);
runtime.execute('agreement.convert', ctx, '2026-07-10T00:00:00Z', () =>
  ag.convert('monthly', '2026-07-10T00:00:00Z', { rateCents: rates.get('dl-rp-month').baseCents, end: '2026-08-10' }),
);

ledger.assertBalanced();

// --- project the accumulated state to SQL ----------------------------------
const world: WorldData = {
  tenants: [TENANT],
  units: [UNIT],
  guests: [GUEST],
  ratePlans: [
    { id: 'dl-rp-night', tenantId: TENANT.id, name: 'Standard Night', kind: 'nightly', baseCents: 20000, currency: 'BRL' },
    { id: 'dl-rp-month', tenantId: TENANT.id, name: 'Standard Month', kind: 'monthly', baseCents: 450000, currency: 'BRL' },
  ],
  agreements: [{ id: ag.id, tenantId: TENANT.id, guestId: GUEST.id, unitId: UNIT.id, events: ag.history }],
  holds: calendar.allHolds(),
  journalLines: ledger.allLines,
  invoices: billing.allInvoices(),
  payments: payments.all(),
  deposits: deposits.all(),
  actionLog: runtime.actionLog(),
};

const statements = projectWorld(world);

// --- persist ----------------------------------------------------------------
async function main() {
  const url = process.env.DATABASE_URL;
  const executor: SqlExecutor = url ? new PgExecutor(url) : new RecordingExecutor();
  await executor.exec(statements);

  if (executor instanceof RecordingExecutor) {
    console.error(`-- demo-live: ${statements.length} statements (no DATABASE_URL; emitting script)`);
    console.log('-- Unified Stay OS — live lifecycle acceptance batch');
    console.log('-- Apply inside a transaction; SET CONSTRAINTS ALL IMMEDIATE to force the');
    console.log('-- deferred journal-balance check (invariant 6) before COMMIT.');
    console.log(renderScript(statements));
  } else {
    console.error(`✅ demo-live: persisted ${statements.length} statements to the live DB; ledger balanced.`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
