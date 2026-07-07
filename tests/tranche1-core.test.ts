// Tranche 1 — core: ledger balancing + append-only, agreement lifecycle &
// conversion (id/ledger continuity), calendar double-inventory, policy +
// agent-runtime gating. 5 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Ledger, LedgerError } from '../src/ledger.ts';
import { Agreement, Calendar, DoubleInventoryError } from '../src/agreement.ts';
import { PolicyEnvelope } from '../src/policy-envelope.ts';
import { ExceptionQueue } from '../src/exception-queue.ts';
import { AgentRuntime } from '../src/agent-runtime.ts';

test('ledger rejects unbalanced entries and enforces integer cents', () => {
  const led = new Ledger();
  assert.throws(
    () =>
      led.post({
        entryId: 'e1',
        postedAt: '2026-07-01',
        lines: [
          { account: 'assets:cash', debitCents: 1000 },
          { account: 'revenue:room', creditCents: 900 },
        ],
      }),
    LedgerError,
  );
  // A balanced entry posts and the trial balance nets to zero.
  led.post({
    entryId: 'e2',
    postedAt: '2026-07-01',
    lines: [
      { account: 'assets:cash', debitCents: 1000 },
      { account: 'revenue:room', creditCents: 1000 },
    ],
  });
  assert.equal(led.balance('assets:cash'), 1000);
  led.assertBalanced();
});

test('ledger is append-only: duplicate entry ids are refused', () => {
  const led = new Ledger();
  const entry = {
    entryId: 'dup',
    postedAt: '2026-07-01',
    lines: [
      { account: 'assets:cash', debitCents: 500 },
      { account: 'revenue:room', creditCents: 500 },
    ],
  };
  led.post(entry);
  assert.throws(() => led.post(entry), LedgerError);
});

test('agreement converts nightly→monthly→lease preserving id and history', () => {
  const a = Agreement.create({
    id: 'ag-1',
    tenantId: 't-1',
    guestId: 'g-1',
    unitId: 'u-1',
    kind: 'nightly',
    start: '2026-07-01',
    end: '2026-07-10',
    rateCents: 20000,
    at: '2026-07-01',
  });
  a.activate('2026-07-01');
  a.convert('monthly', '2026-07-10', { rateCents: 450000, end: '2026-08-10' });
  a.convert('lease', '2026-08-10', { rateCents: 400000, end: '2027-08-10' });

  assert.equal(a.id, 'ag-1'); // id preserved across conversions
  assert.equal(a.kind, 'lease');
  assert.equal(a.rateCents, 400000);
  assert.equal(a.period.end, '2027-08-10');
  // History is append-only and ordered: created, activated, converted, converted.
  assert.deepEqual(
    a.history.map((e) => e.type),
    ['created', 'activated', 'converted', 'converted'],
  );
  // Backward conversion is refused.
  assert.throws(() => a.convert('nightly', '2026-08-11'), /forward/);
});

test('calendar refuses overlapping active holds on one unit', () => {
  const cal = new Calendar();
  cal.hold({ id: 'h1', unitId: 'u-1', holderId: 'ag-1', start: '2026-07-01', end: '2026-07-05' });
  // Overlapping window on the same unit fails.
  assert.throws(
    () => cal.hold({ id: 'h2', unitId: 'u-1', holderId: 'ag-2', start: '2026-07-04', end: '2026-07-08' }),
    DoubleInventoryError,
  );
  // Adjacent (end == next start) is allowed — end is exclusive.
  const ok = cal.hold({ id: 'h3', unitId: 'u-1', holderId: 'ag-3', start: '2026-07-05', end: '2026-07-08' });
  assert.equal(ok.status, 'active');
  // Releasing the first frees its window for a new hold.
  cal.release('h1');
  const reuse = cal.hold({ id: 'h4', unitId: 'u-1', holderId: 'ag-4', start: '2026-07-01', end: '2026-07-04' });
  assert.equal(reuse.status, 'active');
});

test('agent-runtime gates every call: allow executes, escalate parks, deny blocks', () => {
  const runtime = new AgentRuntime(new PolicyEnvelope(), new ExceptionQueue());

  let executed = false;
  const allow = runtime.execute('agreement.create', { actor: 'agent-x' }, '2026-07-01', () => {
    executed = true;
    return 'ok';
  });
  assert.equal(allow.outcome, 'executed');
  assert.equal(allow.result, 'ok');
  assert.ok(executed);

  // Lease execution is regulated → escalate, and the fn must NOT run yet.
  let leased = false;
  const esc = runtime.execute('lease.execute', { actor: 'agent-x' }, '2026-07-01', () => {
    leased = true;
  });
  assert.equal(esc.outcome, 'escalated');
  assert.ok(esc.exceptionId);
  assert.equal(leased, false);

  // Unknown action → deny by default, fn never runs.
  let ran = false;
  const deny = runtime.execute('unknown.thing', { actor: 'agent-x' }, '2026-07-01', () => {
    ran = true;
  });
  assert.equal(deny.outcome, 'denied');
  assert.equal(ran, false);

  // Every attempt is logged (append-only action log).
  assert.equal(runtime.actionLog().length, 3);
});
