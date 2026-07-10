// Tranche 35 — connector adapter routing. The pure decision the connector-worker
// edge function drains the outbox through: what may be dispatched to a vendor,
// and what is refused. Money rails are refused at the edge (human-approved only),
// on top of the policy envelope already escalating a large payout. 8 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planConnectorCommand, DISPATCHABLE_KINDS, MONEY_KINDS } from '../src/connector-adapters.ts';

test('a hardware command with a resolved secret is dispatched', () => {
  const p = planConnectorCommand({ action: 'lock.unlock', kind: 'lock', secretResolved: true, payload: { spaceId: 's-1' } });
  assert.equal(p.decision, 'dispatch');
  assert.equal(p.reason, 'ok');
});

test('every dispatchable kind routes to dispatch when the secret resolves', () => {
  for (const kind of DISPATCHABLE_KINDS) {
    assert.equal(planConnectorCommand({ action: 'do.thing', kind, secretResolved: true }).decision, 'dispatch', kind);
  }
});

test('a bank / payment_gateway command is REFUSED (money rail, human-approved only)', () => {
  for (const kind of MONEY_KINDS) {
    const p = planConnectorCommand({ action: 'bank.payout', kind, secretResolved: true, payload: { amountCents: 100 } });
    assert.equal(p.decision, 'refuse', kind);
    assert.equal(p.reason, 'money_rail_requires_human_approved_adapter');
  }
});

test('a money rail is refused EVEN with a resolved secret and a tiny amount', () => {
  // The refusal is unconditional at the drain edge — not amount-based (the policy
  // envelope already escalates large payouts before enqueue; this is belt-and-braces).
  assert.equal(planConnectorCommand({ action: 'gw.charge', kind: 'payment_gateway', secretResolved: true, payload: { amountCents: 1 } }).decision, 'refuse');
});

test('a dispatchable kind WITHOUT a resolved secret is rejected', () => {
  assert.equal(planConnectorCommand({ action: 'lock.unlock', kind: 'lock', secretResolved: false }).decision, 'reject');
  assert.equal(planConnectorCommand({ action: 'lock.unlock', kind: 'lock', secretResolved: false }).reason, 'missing_secret');
});

test('an unknown kind is rejected', () => {
  const p = planConnectorCommand({ action: 'x', kind: 'satellite' as never, secretResolved: true });
  assert.equal(p.decision, 'reject');
  assert.ok(p.reason.startsWith('unsupported_kind:'));
});

test('a command with no action is rejected before anything else', () => {
  assert.equal(planConnectorCommand({ action: '', kind: 'lock', secretResolved: true }).decision, 'reject');
  // a money rail with no action still rejects on action first
  assert.equal(planConnectorCommand({ action: '', kind: 'bank', secretResolved: true }).reason, 'missing_action');
});

test('the decision is deterministic and side-effect-free (same input → same output)', () => {
  const input = { action: 'elevator.call', kind: 'elevator' as const, secretResolved: true, payload: { floor: 3 } };
  assert.deepEqual(planConnectorCommand(input), planConnectorCommand(input));
});
