// Tranche 14 — Phase 1 through the Public API: parties & roles, spaces, the
// legal-entity + charge catalog, charge-routed invoices incl. the condominium
// pass-through (#11), lease escalation (#8), unit transfer (#23), and accounts
// payable with policy-gated payout (#22). Every write goes through the same
// auth → RBAC → policy gates. 12 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';

const T = '2026-07-01T00:00:00Z';
const bearer = (t: string) => `Bearer ${t}`;

function makeApp() {
  const owner: AuthContext = { actor: 'ana', tenantId: 't1', role: 'owner' };
  const agent: AuthContext = { actor: 'bot', tenantId: 't1', role: 'agent' };
  const reader: AuthContext = { actor: 'aud', tenantId: 't1', role: 'read_only' };
  const auth = new StaticTokenAuthenticator({ own: owner, bot: agent, ro: reader });
  return new App({
    authenticator: auth,
    units: [{ id: 'u-1', tenantId: 't1' }, { id: 'u-2', tenantId: 't1' }],
    now: () => T,
  });
}
const D = (app: App, method: string, path: string, token: string, body?: Record<string, unknown>) =>
  app.dispatch({ method, path, bearer: bearer(token), body });

function bookActive(app: App, id = 'ag-1', unitId = 'u-1') {
  D(app, 'POST', '/agreements', 'own', { id, guestId: 'g-1', unitId, kind: 'monthly', start: '2026-07-01', end: '2027-07-01', rateCents: 300000 });
  D(app, 'POST', `/agreements/${id}/activate`, 'own', {});
}

// --- Party & roles ---------------------------------------------------------
test('party + role assignment; billTo prefers the payer over the resident (#10)', () => {
  const app = makeApp();
  bookActive(app);
  assert.equal(D(app, 'POST', '/parties', 'own', { id: 'p-stu', kind: 'person', displayName: 'Student' }).status, 201);
  D(app, 'POST', '/parties', 'own', { id: 'p-par', kind: 'person', displayName: 'Parent' });
  D(app, 'POST', '/agreements/ag-1/parties', 'own', { partyId: 'p-stu', role: 'resident' });
  D(app, 'POST', '/agreements/ag-1/parties', 'own', { partyId: 'p-par', role: 'financial_responsible' });
  const res = D(app, 'GET', '/agreements/ag-1/parties', 'own');
  assert.equal(res.status, 200);
  assert.equal((res.body as { billToPartyId: string }).billToPartyId, 'p-par');
});

test('read_only cannot create a party (RBAC 403)', () => {
  const app = makeApp();
  assert.equal(D(app, 'POST', '/parties', 'ro', { id: 'p', kind: 'person', displayName: 'x' }).status, 403);
});

// --- Spaces ----------------------------------------------------------------
test('space hierarchy is created and listed through the API', () => {
  const app = makeApp();
  assert.equal(D(app, 'POST', '/spaces', 'own', { id: 's-prop', type: 'property', code: 'VM42', label: 'Vila 42', leasable: false }).status, 201);
  D(app, 'POST', '/spaces', 'own', { id: 's-u', parentId: 's-prop', type: 'unit', code: 'A-304', label: 'Unit 304', leasable: true });
  D(app, 'POST', '/spaces', 'own', { id: 's-bed', parentId: 's-u', type: 'bed', code: 'A-304-b1', label: 'Bed 1', leasable: true });
  const res = D(app, 'GET', '/spaces', 'own');
  assert.equal((res.body as { spaces: unknown[] }).spaces.length, 3);
});

// --- Charge catalog + routed invoicing -------------------------------------
function seedEntities(app: App) {
  D(app, 'POST', '/legal-entities', 'own', { id: 'op', role: 'operator', name: 'Elara Op' });
  D(app, 'POST', '/legal-entities', 'own', { id: 'condo', role: 'condominium', name: 'Condo Assn' });
  D(app, 'POST', '/charge-types', 'own', { id: 'ct-rent', code: 'rent', name: 'Rent', receivingEntityId: 'op', glAccount: 'revenue:room', recurring: true });
  D(app, 'POST', '/charge-types', 'own', { id: 'ct-condo', code: 'condo_fee', name: 'Condominium', receivingEntityId: 'condo', glAccount: 'liabilities:due_to_condominium', recurring: true });
}

test('charge-routed invoice stamps the receiving entity and the payer (#10 #11)', () => {
  const app = makeApp();
  bookActive(app);
  seedEntities(app);
  D(app, 'POST', '/parties', 'own', { id: 'p-par', kind: 'person', displayName: 'Parent' });
  D(app, 'POST', '/agreements/ag-1/parties', 'own', { partyId: 'p-par', role: 'financial_responsible' });

  const res = D(app, 'POST', '/invoices', 'own', {
    id: 'inv-rent', agreementId: 'ag-1', dueAt: '2026-07-05',
    lines: [{ description: 'July rent', chargeCode: 'rent', amountCents: 300000 }],
  });
  assert.equal(res.status, 201);
  const inv = res.body as { receivingEntityId: string; billToPartyId: string; lines: Array<{ account: string; chargeType: string }> };
  assert.equal(inv.receivingEntityId, 'op');
  assert.equal(inv.billToPartyId, 'p-par');
  assert.equal(inv.lines[0]!.account, 'revenue:room'); // resolved from the charge code
  assert.equal(inv.lines[0]!.chargeType, 'rent');
});

test('condominium pass-through: condo fee books to a due-to-condominium liability (#11)', () => {
  const app = makeApp();
  bookActive(app);
  seedEntities(app);
  const res = D(app, 'POST', '/invoices', 'own', {
    id: 'inv-condo', agreementId: 'ag-1', dueAt: '2026-07-05',
    lines: [{ description: 'July condo', chargeCode: 'condo_fee', amountCents: 30000 }],
  });
  assert.equal((res.body as { receivingEntityId: string }).receivingEntityId, 'condo');
  // The money is a liability owed onward, never operator revenue.
  assert.equal(app.ledger.balance('liabilities:due_to_condominium'), -30000);
  assert.equal(app.ledger.balance('assets:accounts_receivable'), 30000);
  assert.equal(app.ledger.balance('revenue:room'), 0);
});

test('lines routing to two different entities on one invoice are rejected (400)', () => {
  const app = makeApp();
  bookActive(app);
  seedEntities(app);
  const res = D(app, 'POST', '/invoices', 'own', {
    id: 'inv-mix', agreementId: 'ag-1', dueAt: '2026-07-05',
    lines: [
      { description: 'rent', chargeCode: 'rent', amountCents: 300000 },
      { description: 'condo', chargeCode: 'condo_fee', amountCents: 30000 },
    ],
  });
  assert.equal(res.status, 400);
});

// --- Lease escalation (#8) -------------------------------------------------
test('rent adjustment by percent raises the rate and records an event (#8)', () => {
  const app = makeApp();
  bookActive(app);
  const res = D(app, 'POST', '/agreements/ag-1/adjust-rent', 'own', { basis: 'percent', value: 10, reason: 'annual index' });
  assert.equal(res.status, 200);
  assert.equal((res.body as { rateCents: number }).rateCents, 330000); // 300000 + 10%
  const hist = D(app, 'GET', '/agreements/ag-1', 'own').body as { history: Array<{ type: string; payload: Record<string, unknown> }> };
  const adj = hist.history.find((e) => e.type === 'rent_adjusted')!;
  assert.equal(adj.payload['from'], 300000);
  assert.equal(adj.payload['rateCents'], 330000);
});

// --- Unit transfer (#23) ---------------------------------------------------
test('unit transfer moves the agreement and swaps the calendar hold (#23)', () => {
  const app = makeApp();
  bookActive(app); // holds u-1
  const res = D(app, 'POST', '/agreements/ag-1/transfer', 'own', { toUnitId: 'u-2', reason: 'upgrade' });
  assert.equal(res.status, 200);
  assert.equal((res.body as { unitId: string }).unitId, 'u-2');
  const active = app.calendar.activeHolds().filter((h) => h.holderId === 'ag-1');
  assert.equal(active.length, 1);
  assert.equal(active[0]!.unitId, 'u-2'); // hold followed the transfer
});

// --- Accounts payable (#22) ------------------------------------------------
test('AP: issue a bill and settle it; the ledger clears payable against cash', () => {
  const app = makeApp();
  D(app, 'POST', '/parties', 'own', { id: 'v-1', kind: 'organization', displayName: 'Acme Plumbing' });
  const issued = D(app, 'POST', '/bills', 'own', {
    id: 'b-1', payeeId: 'v-1', dueAt: '2026-07-15',
    lines: [{ description: 'repair', account: 'expenses:supplier', amountCents: 25000 }],
  });
  assert.equal(issued.status, 201);
  const paid = D(app, 'POST', '/bills/b-1/pay', 'own', { id: 'ap-1', amountCents: 25000, method: 'pix' });
  assert.equal(paid.status, 201);
  assert.equal(app.ledger.balance('liabilities:accounts_payable'), 0);
  assert.equal(app.ledger.balance('assets:cash'), -25000);
});

test('AP: paying more than R$5,000 out escalates to a human (policy, #21)', () => {
  const app = makeApp();
  D(app, 'POST', '/parties', 'own', { id: 'v-2', kind: 'organization', displayName: 'Big Vendor' });
  D(app, 'POST', '/bills', 'own', { id: 'b-2', payeeId: 'v-2', dueAt: '2026-07-15', lines: [{ description: 'roof', account: 'expenses:supplier', amountCents: 600000 }] });
  const res = D(app, 'POST', '/bills/b-2/pay', 'own', { id: 'ap-2', amountCents: 600000, method: 'transfer' });
  assert.equal(res.status, 202); // escalated, not executed
  assert.equal((res.body as { status: string }).status, 'escalated');
  assert.equal(app.ledger.balance('liabilities:accounts_payable'), -600000); // still owed
});

test('AP: an agent may issue a bill but not pay one (RBAC 403)', () => {
  const app = makeApp();
  D(app, 'POST', '/parties', 'own', { id: 'v-3', kind: 'organization', displayName: 'Vendor' });
  assert.equal(D(app, 'POST', '/bills', 'bot', { id: 'b-3', payeeId: 'v-3', dueAt: '2026-07-15', lines: [{ description: 'x', account: 'expenses:supplier', amountCents: 1000 }] }).status, 201);
  assert.equal(D(app, 'POST', '/bills/b-3/pay', 'bot', { id: 'ap-3', amountCents: 1000, method: 'pix' }).status, 403);
});

test('refund a resident as a bill to the resident-party, settled via AP (#22)', () => {
  const app = makeApp();
  bookActive(app);
  // A deposit was taken (cash in, liability owed back).
  D(app, 'POST', '/deposits', 'own', { id: 'dep-1', agreementId: 'ag-1', amountCents: 50000 });
  D(app, 'POST', '/parties', 'own', { id: 'p-res', kind: 'person', displayName: 'Resident' });
  // Move-out refund of the non-deducted portion, as a payable to the resident.
  D(app, 'POST', '/bills', 'own', { id: 'refund-1', payeeId: 'p-res', dueAt: '2026-07-20', memo: 'deposit refund', lines: [{ description: 'deposit returned', account: 'liabilities:deposits_held', amountCents: 42000 }] });
  const paid = D(app, 'POST', '/bills/refund-1/pay', 'own', { id: 'ap-ref-1', amountCents: 42000, method: 'pix' });
  assert.equal(paid.status, 201);
  // Held liability is credit-normal: -50000 held + 42000 returned = -8000 still owed.
  assert.equal(app.ledger.balance('liabilities:deposits_held'), -8000);
  assert.doesNotThrow(() => app.ledger.assertBalanced());
});
