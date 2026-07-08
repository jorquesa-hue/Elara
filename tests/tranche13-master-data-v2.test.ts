// Tranche 13 — master-data reshape foundations: the Party directory, the Space
// tree, the legal-entity + charge catalog, and accounts payable. These are the
// skeleton the larger feature set hangs off; every entity is tenant-scoped and
// posts (where money moves) through the balanced ledger. 12 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Ledger } from '../src/ledger.ts';
import { PartyDirectory, PartyError } from '../src/party.ts';
import { SpaceTree, SpaceError } from '../src/space.ts';
import { EntityCatalog, EntityError } from '../src/entity.ts';
import { Payables, PayablesError } from '../src/payables.ts';
import { ACCOUNTS } from '../src/billing.ts';

// --- Party -----------------------------------------------------------------
test('party directory: add, tenant scoping, duplicate rejected', () => {
  const d = new PartyDirectory();
  d.addParty({ id: 'p-ana', tenantId: 't1', kind: 'person', displayName: 'Ana Souza' });
  assert.equal(d.getParty('t1', 'p-ana')?.displayName, 'Ana Souza');
  assert.equal(d.getParty('t2', 'p-ana'), null); // cross-tenant hidden
  assert.throws(() => d.addParty({ id: 'p-ana', tenantId: 't1', kind: 'person', displayName: 'dup' }), PartyError);
});

test('billTo prefers financial_responsible, falls back to resident (#10)', () => {
  const d = new PartyDirectory();
  d.addParty({ id: 'p-student', tenantId: 't1', kind: 'person', displayName: 'Student' });
  d.addParty({ id: 'p-parent', tenantId: 't1', kind: 'person', displayName: 'Parent' });
  d.assign({ agreementId: 'ag-1', partyId: 'p-student', role: 'resident' });
  assert.equal(d.billTo('ag-1'), 'p-student'); // resident until a payer is set
  d.assign({ agreementId: 'ag-1', partyId: 'p-parent', role: 'financial_responsible' });
  assert.equal(d.billTo('ag-1'), 'p-parent'); // parent pays, student lives there
});

test('party roles: unknown role, unknown party, and share bounds are rejected', () => {
  const d = new PartyDirectory();
  d.addParty({ id: 'p1', tenantId: 't1', kind: 'person', displayName: 'X' });
  // @ts-expect-error invalid role at runtime
  assert.throws(() => d.assign({ agreementId: 'a', partyId: 'p1', role: 'landlord' }), PartyError);
  assert.throws(() => d.assign({ agreementId: 'a', partyId: 'ghost', role: 'resident' }), PartyError);
  assert.throws(() => d.assign({ agreementId: 'a', partyId: 'p1', role: 'cosigner', sharePct: 140 }), PartyError);
});

test('a role can be released and reassigned (payer changes mid-lease)', () => {
  const d = new PartyDirectory();
  d.addParty({ id: 'p1', tenantId: 't1', kind: 'person', displayName: 'A' });
  d.addParty({ id: 'p2', tenantId: 't1', kind: 'person', displayName: 'B' });
  d.assign({ agreementId: 'ag', partyId: 'p1', role: 'financial_responsible' });
  d.release('ag', 'p1', 'financial_responsible', '2026-07-01');
  d.assign({ agreementId: 'ag', partyId: 'p2', role: 'financial_responsible' });
  assert.equal(d.billTo('ag'), 'p2');
  assert.equal(d.partiesFor('ag', 'financial_responsible').length, 1); // only the open one
});

// --- Space -----------------------------------------------------------------
test('space tree: hierarchy, ancestors, path, and leasable filter', () => {
  const s = new SpaceTree();
  s.add({ id: 'prop', tenantId: 't1', type: 'property', code: 'VM42', label: 'Vila Madalena 42', leasable: false });
  s.add({ id: 'blkA', tenantId: 't1', parentId: 'prop', type: 'building', code: 'A', label: 'Block A', leasable: false });
  s.add({ id: 'u304', tenantId: 't1', parentId: 'blkA', type: 'unit', code: 'A-304', label: 'Unit 304', leasable: true });
  s.add({ id: 'r1', tenantId: 't1', parentId: 'u304', type: 'room', code: 'A-304-R1', label: 'Room 1', leasable: true });

  assert.deepEqual(s.ancestors('r1').map((x) => x.code), ['A-304', 'A', 'VM42']);
  assert.equal(s.path('t1', 'r1'), 'VM42 / A / A-304 / A-304-R1');
  assert.equal(s.descendants('prop').length, 3);
  assert.deepEqual(s.leasable('t1').map((x) => x.code).sort(), ['A-304', 'A-304-R1']);
});

test('space tree: parent must exist and share the tenant; codes unique per tenant', () => {
  const s = new SpaceTree();
  s.add({ id: 'prop', tenantId: 't1', type: 'property', code: 'P', label: 'P', leasable: false });
  assert.throws(() => s.add({ id: 'x', tenantId: 't1', parentId: 'ghost', type: 'unit', code: 'U', label: 'U', leasable: true }), SpaceError);
  assert.throws(() => s.add({ id: 'y', tenantId: 't1', type: 'unit', code: 'P', label: 'dup code', leasable: true }), SpaceError);
  // same code is fine in a different tenant
  assert.doesNotThrow(() => s.add({ id: 'z', tenantId: 't2', type: 'property', code: 'P', label: 'other', leasable: false }));
});

// --- Legal entity + charge catalog ----------------------------------------
test('charge catalog routes a charge to its GL account + receiving entity (#11)', () => {
  const c = new EntityCatalog();
  c.addEntity({ id: 'op', tenantId: 't1', role: 'operator', name: 'Elara Op' });
  c.addEntity({ id: 'condo', tenantId: 't1', role: 'condominium', name: 'Condo Assn' });
  c.addChargeType({ id: 'ct-rent', tenantId: 't1', code: 'rent', name: 'Rent', receivingEntityId: 'op', glAccount: 'revenue:room', recurring: true });
  c.addChargeType({ id: 'ct-condo', tenantId: 't1', code: 'condo_fee', name: 'Condominium', receivingEntityId: 'condo', glAccount: 'liabilities:due_to_condominium', recurring: true });

  assert.deepEqual(c.resolve('t1', 'rent'), { glAccount: 'revenue:room', receivingEntityId: 'op' });
  assert.deepEqual(c.resolve('t1', 'condo_fee'), { glAccount: 'liabilities:due_to_condominium', receivingEntityId: 'condo' });
});

test('charge type requires a real receiving entity and a unique code', () => {
  const c = new EntityCatalog();
  c.addEntity({ id: 'op', tenantId: 't1', role: 'operator', name: 'Op' });
  assert.throws(() => c.addChargeType({ id: 'ct', tenantId: 't1', code: 'rent', name: 'r', receivingEntityId: 'ghost', glAccount: 'revenue:room', recurring: true }), EntityError);
  c.addChargeType({ id: 'ct1', tenantId: 't1', code: 'rent', name: 'r', receivingEntityId: 'op', glAccount: 'revenue:room', recurring: true });
  assert.throws(() => c.addChargeType({ id: 'ct2', tenantId: 't1', code: 'rent', name: 'dup', receivingEntityId: 'op', glAccount: 'revenue:room', recurring: true }), EntityError);
  assert.throws(() => c.resolve('t1', 'nope'), EntityError);
});

// --- Accounts payable ------------------------------------------------------
test('payables: a bill posts DR expense / CR accounts payable and balances', () => {
  const ledger = new Ledger();
  const ap = new Payables(ledger);
  ap.issue({
    id: 'b-1', tenantId: 't1', payeeId: 'p-vendor', issuedAt: '2026-07-01T00:00:00Z', dueAt: '2026-07-15T00:00:00Z',
    lines: [{ description: 'plumbing', account: ACCOUNTS.supplierExpense, amountCents: 30000 }],
  });
  assert.equal(ledger.balance(ACCOUNTS.supplierExpense), 30000);   // expense debited
  assert.equal(ledger.balance(ACCOUNTS.accountsPayable), -30000);  // liability credited
  assert.doesNotThrow(() => ledger.assertBalanced());
});

test('payables: paying a bill clears AP against cash; overpay is rejected', () => {
  const ledger = new Ledger();
  const ap = new Payables(ledger);
  ap.issue({ id: 'b-2', tenantId: 't1', payeeId: 'v', issuedAt: '2026-07-01T00:00:00Z', dueAt: '2026-07-15T00:00:00Z', lines: [{ description: 'x', account: ACCOUNTS.supplierExpense, amountCents: 20000 }] });
  ap.pay({ id: 'ap-1', billId: 'b-2', amountCents: 20000, method: 'pix', paidAt: '2026-07-10T00:00:00Z' });
  assert.equal(ap.get('b-2').status, 'paid');
  assert.equal(ledger.balance(ACCOUNTS.accountsPayable), 0); // fully cleared
  assert.equal(ledger.balance(ACCOUNTS.cash), -20000);       // cash out
  assert.doesNotThrow(() => ledger.assertBalanced());
  assert.throws(() => ap.pay({ id: 'ap-2', billId: 'b-2', amountCents: 1, method: 'pix', paidAt: '2026-07-11T00:00:00Z' }), PayablesError);
});

test('resident refund = a bill to the resident-party, settled as a payment (#22)', () => {
  const ledger = new Ledger();
  const ap = new Payables(ledger);
  // A deposit was taken earlier: cash in, a liability owed back to the resident.
  ledger.post({
    entryId: 'seed-hold', postedAt: '2026-07-01T00:00:00Z',
    lines: [
      { account: ACCOUNTS.cash, debitCents: 42000 },
      { account: ACCOUNTS.depositsHeld, creditCents: 42000 },
    ],
  });
  // Move-out refund: a bill to the resident-party clears the held liability,
  // and the AP payment returns the cash — no bespoke refund path.
  ap.issue({
    id: 'refund-dep-1', tenantId: 't1', payeeId: 'p-resident', issuedAt: '2026-08-01T00:00:00Z', dueAt: '2026-08-01T00:00:00Z',
    memo: 'deposit refund', lines: [{ description: 'deposit returned', account: ACCOUNTS.depositsHeld, amountCents: 42000 }],
  });
  const pay = ap.pay({ id: 'ap-refund-1', billId: 'refund-dep-1', amountCents: 42000, method: 'pix', paidAt: '2026-08-02T00:00:00Z' });
  assert.equal(pay.status, 'settled');
  assert.equal(ledger.balance(ACCOUNTS.depositsHeld), 0); // held liability released
  assert.equal(ledger.balance(ACCOUNTS.cash), 0);         // deposit in, refund out — nets to zero
  assert.doesNotThrow(() => ledger.assertBalanced());
});

test('payables surfaces open bills and rejects an empty bill', () => {
  const ledger = new Ledger();
  const ap = new Payables(ledger);
  assert.throws(() => ap.issue({ id: 'b', tenantId: 't1', payeeId: 'v', issuedAt: '2026-07-01T00:00:00Z', dueAt: '2026-07-02T00:00:00Z', lines: [] }), PayablesError);
  ap.issue({ id: 'b-open', tenantId: 't1', payeeId: 'v', issuedAt: '2026-07-01T00:00:00Z', dueAt: '2026-07-15T00:00:00Z', lines: [{ description: 'x', account: ACCOUNTS.supplierExpense, amountCents: 5000 }] });
  assert.equal(ap.openBills().length, 1);
});
