// Tranche 4 — persistence: the world projection emits FK-ordered, balanced,
// correctly-typed SQL, and the executor renders runnable script text. 4 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Ledger,
  Agreement,
  Calendar,
  Billing,
  ACCOUNTS,
  Payments,
  Deposits,
  PolicyEnvelope,
  ExceptionQueue,
  AgentRuntime,
} from '../src/index.ts';
import { projectWorld, type WorldData } from '../src/persistence/project.ts';
import {
  RecordingExecutor,
  renderStatement,
  renderScript,
  renderLiteral,
} from '../src/persistence/executor.ts';

// Build a small but representative world exercised through the runtime.
function buildWorld(): WorldData {
  const ledger = new Ledger();
  const billing = new Billing(ledger);
  const payments = new Payments(ledger, billing);
  const deposits = new Deposits(ledger);
  const calendar = new Calendar();
  const runtime = new AgentRuntime(new PolicyEnvelope(), new ExceptionQueue());

  const a = Agreement.create({
    id: 'ag-1',
    tenantId: 't-1',
    guestId: 'g-1',
    unitId: 'u-1',
    kind: 'nightly',
    start: '2026-07-01',
    end: '2026-07-05',
    rateCents: 20000,
    at: '2026-07-01T00:00:00Z',
  });
  runtime.execute('agreement.activate', { actor: 'agent' }, '2026-07-01T00:00:00Z', () =>
    a.activate('2026-07-01T00:00:00Z'),
  );
  calendar.hold({ id: 'ag-1-hold', unitId: 'u-1', holderId: 'ag-1', start: '2026-07-01', end: '2026-07-05' });

  runtime.execute('invoice.issue', { actor: 'agent' }, '2026-07-01T00:00:00Z', () =>
    billing.issue({
      id: 'inv-1',
      agreementId: 'ag-1',
      tenantId: 't-1',
      issuedAt: '2026-07-01T00:00:00Z',
      dueAt: '2026-07-05T00:00:00Z',
      lines: [{ description: '4 nights', account: ACCOUNTS.roomRevenue, amountCents: 80000 }],
    }),
  );
  payments.record({ id: 'pay-1', invoiceId: 'inv-1', amountCents: 80000, method: 'pix', receivedAt: '2026-07-02T00:00:00Z' });
  deposits.hold({ id: 'dep-1', agreementId: 'ag-1', amountCents: 50000, heldAt: '2026-07-02T00:00:00Z' });

  return {
    tenants: [{ id: 't-1', name: 'Rio Ops' }],
    units: [{ id: 'u-1', tenantId: 't-1', label: '101' }],
    guests: [{ id: 'g-1', tenantId: 't-1', fullName: 'Ana' }],
    agreements: [{ id: 'ag-1', tenantId: 't-1', guestId: 'g-1', unitId: 'u-1', events: a.history }],
    holds: calendar.allHolds(),
    journalLines: ledger.allLines,
    invoices: billing.allInvoices(),
    payments: payments.all(),
    deposits: deposits.all(),
    actionLog: runtime.actionLog(),
  };
}

test('projection emits statements in FK-safe order', () => {
  const stmts = projectWorld(buildWorld());
  const tableOf = (s: string) => s.match(/^insert into (\w+)/)?.[1];
  const order = stmts.map((s) => tableOf(s.text)!);
  const firstIndex = (tbl: string) => order.indexOf(tbl);

  // Parents must appear before children.
  assert.ok(firstIndex('tenant') < firstIndex('unit'));
  assert.ok(firstIndex('tenant') < firstIndex('guest'));
  assert.ok(firstIndex('unit') < firstIndex('agreement'));
  assert.ok(firstIndex('guest') < firstIndex('agreement'));
  assert.ok(firstIndex('agreement') < firstIndex('agreement_event'));
  assert.ok(firstIndex('unit') < firstIndex('calendar_hold'));
  assert.ok(firstIndex('agreement') < firstIndex('journal_line'));
  assert.ok(firstIndex('invoice') < firstIndex('invoice_line'));
  assert.ok(firstIndex('invoice') < firstIndex('payment'));
});

test('projected journal lines net to zero (balance survives the round-trip)', () => {
  const stmts = projectWorld(buildWorld());
  let net = 0;
  for (const s of stmts) {
    if (!s.text.startsWith('insert into journal_line')) continue;
    // values: entry_id, account, debit_cents, credit_cents, ...
    const debit = s.values[2] as number;
    const credit = s.values[3] as number;
    net += debit - credit;
  }
  assert.equal(net, 0);
});

test('jsonb payloads are stringified and cast, dates pass through as text', () => {
  const stmts = projectWorld(buildWorld());
  const evt = stmts.find((s) => s.text.startsWith('insert into agreement_event'))!;
  assert.match(evt.text, /\$4::jsonb/);
  assert.equal(typeof evt.values[3], 'string'); // JSON string, not an object
  assert.doesNotThrow(() => JSON.parse(evt.values[3] as string));

  const hold = stmts.find((s) => s.text.startsWith('insert into calendar_hold'))!;
  assert.equal(hold.values[3], '2026-07-01'); // start_date as ISO date text
});

test('executor renders runnable, injection-safe script text', () => {
  const rec = new RecordingExecutor();
  const stmts = projectWorld(buildWorld());
  return rec.exec(stmts).then(() => {
    assert.equal(rec.statements.length, stmts.length);
    const script = renderScript(rec.statements);
    assert.ok(script.split('\n').every((line) => line.trim().endsWith(';')));
    // No unbound placeholders remain after rendering.
    assert.doesNotMatch(script, /\$\d/);
    // Single quotes in data are doubled, not left to break out of the literal.
    assert.equal(renderLiteral("O'Brien"), "'O''Brien'");
    assert.equal(renderLiteral(1200), '1200');
    assert.equal(renderLiteral(null), 'null');
    // $10 is not shadowed by $1 during rendering.
    assert.equal(
      renderStatement({ text: 'x ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }),
      'x (1,2,3,4,5,6,7,8,9,10);',
    );
  });
});
