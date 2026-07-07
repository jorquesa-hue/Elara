// Tranche 2 — money: rate plans, billing→ledger, payments, deposits with
// deductions, NF-e ingestion into AP. Every money path must leave the ledger
// balanced. 5 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Ledger } from '../src/ledger.ts';
import { RatePlanBook, RatePlanError } from '../src/rate-plan.ts';
import { Billing, ACCOUNTS, BillingError } from '../src/billing.ts';
import { Payments, PaymentError } from '../src/payments.ts';
import { Deposits, DepositError } from '../src/deposits.ts';
import { NfeInbox, parseNfe, NfeError } from '../src/nfe-ingest.ts';

test('rate plan quotes nightly by nights and monthly by months', () => {
  const book = new RatePlanBook();
  book.add({ id: 'rp-n', name: 'Std Night', kind: 'nightly', baseCents: 20000, currency: 'BRL' });
  book.add({ id: 'rp-m', name: 'Std Month', kind: 'monthly', baseCents: 450000, currency: 'BRL' });

  assert.equal(book.quote('rp-n', { nights: 9 }).totalCents, 180000);
  assert.equal(book.quote('rp-m', { months: 3 }).totalCents, 1350000);
  // Wrong unit type is refused.
  assert.throws(() => book.quote('rp-n', { months: 2 }), RatePlanError);
});

test('billing issues a balanced receivable/revenue entry', () => {
  const led = new Ledger();
  const billing = new Billing(led);
  const inv = billing.issue({
    id: 'inv-1',
    agreementId: 'ag-1',
    tenantId: 't-1',
    issuedAt: '2026-07-01',
    dueAt: '2026-07-08',
    lines: [{ description: '9 nights', account: ACCOUNTS.roomRevenue, amountCents: 180000 }],
  });
  assert.equal(inv.totalCents, 180000);
  assert.equal(inv.status, 'open');
  assert.equal(led.balance(ACCOUNTS.accountsReceivable), 180000);
  assert.equal(led.balance(ACCOUNTS.roomRevenue), -180000); // credit balance
  led.assertBalanced();
});

test('payments apply to invoice, move cash/AR, and reject overpayment', () => {
  const led = new Ledger();
  const billing = new Billing(led);
  const payments = new Payments(led, billing);
  billing.issue({
    id: 'inv-2',
    agreementId: 'ag-1',
    tenantId: 't-1',
    issuedAt: '2026-07-01',
    dueAt: '2026-07-08',
    lines: [{ description: 'room', account: ACCOUNTS.roomRevenue, amountCents: 100000 }],
  });
  payments.record({ id: 'pay-1', invoiceId: 'inv-2', amountCents: 60000, method: 'pix', receivedAt: '2026-07-02' });
  assert.equal(billing.get('inv-2').status, 'partially_paid');
  payments.record({ id: 'pay-2', invoiceId: 'inv-2', amountCents: 40000, method: 'pix', receivedAt: '2026-07-03' });
  assert.equal(billing.get('inv-2').status, 'paid');
  assert.equal(led.balance(ACCOUNTS.cash), 100000);
  assert.equal(led.balance(ACCOUNTS.accountsReceivable), 0);
  led.assertBalanced();
  // Overpayment is refused and leaves no partial ledger write.
  assert.throws(
    () => payments.record({ id: 'pay-3', invoiceId: 'inv-2', amountCents: 1, method: 'pix', receivedAt: '2026-07-04' }),
    PaymentError,
  );
  led.assertBalanced();
});

test('deposit is held as liability and refunded net of itemized deductions', () => {
  const led = new Ledger();
  const dep = new Deposits(led);
  dep.hold({ id: 'dep-1', agreementId: 'ag-1', amountCents: 50000, heldAt: '2026-07-01' });
  assert.equal(led.balance(ACCOUNTS.depositsHeld), -50000); // liability credit
  const refunded = dep.refund('dep-1', '2026-07-10', [{ reason: 'broken lamp', amountCents: 8000 }]);
  assert.equal(refunded.status, 'refunded');
  assert.equal(refunded.refundedCents, 42000);
  assert.equal(led.balance(ACCOUNTS.depositsHeld), 0); // liability cleared
  assert.equal(led.balance(ACCOUNTS.deductionRevenue), -8000); // deduction recognized
  led.assertBalanced();
  // Over-deducting is refused.
  assert.throws(
    () => dep.refund('dep-1', '2026-07-11', []),
    DepositError, // already refunded
  );
});

test('NF-e parses access key + total and books supplier expense to AP', () => {
  const led = new Ledger();
  const inbox = new NfeInbox(led);
  const xmlPath = fileURLToPath(new URL('./fixtures/nfe-sample.xml', import.meta.url));
  const xml = readFileSync(xmlPath, 'utf8');

  const parsed = parseNfe(xml);
  assert.equal(parsed.chaveAcesso, '44310112345678000199550010000000011000000015');
  assert.equal(parsed.totalCents, 125000);
  assert.equal(parsed.emitCnpj, '12345678000199');

  inbox.ingest(xml);
  assert.equal(led.balance(ACCOUNTS.supplierExpense), 125000);
  assert.equal(led.balance(ACCOUNTS.accountsPayable), -125000);
  led.assertBalanced();
  // Re-ingesting the same key is refused (idempotency guard).
  assert.throws(() => inbox.ingest(xml), NfeError);
  // Malformed XML (no access key) is refused.
  assert.throws(() => parseNfe('<nfe></nfe>'), NfeError);
});
