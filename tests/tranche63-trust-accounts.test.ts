// Tranche 63 — Phase 1D: trust / segregated deposit bank accounts. Security
// deposit cash must not commingle with operating cash; a trust bank account has
// its own GL cash account, so deposits book there and refund returns from it.
// Bank-account CRUD, deposit routing, projection SQL, snapshot→rehydrate. 8 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';
import { projectWorld } from '../src/persistence/project.ts';

const NOW = '2026-07-13T00:00:00Z';
const own: AuthContext = { actor: 'own', tenantId: 'mf', role: 'owner' };
const acct: AuthContext = { actor: 'acc', tenantId: 'mf', role: 'accountant' };
const desk: AuthContext = { actor: 'fd', tenantId: 'mf', role: 'front_desk' };

function mkApp() {
  return new App({ authenticator: new StaticTokenAuthenticator({ own, acc: acct, fd: desk }), units: [], now: () => NOW });
}
const D = (app: App, method: string, path: string, body?: Record<string, unknown>, token = 'own') =>
  app.dispatch({ method, path, bearer: `Bearer ${token}`, body: body ?? {} });

function seed(app: App) {
  D(app, 'PUT', '/config', { displayName: 'Greyline', country: 'US' });
  D(app, 'POST', '/units', { id: 'u-1', code: 'A-1', label: 'A1' });
  D(app, 'POST', '/agreements', { id: 'ag-1', guestId: 'g-1', unitId: 'u-1', kind: 'monthly', start: '2026-07-01', end: '2027-07-01', rateCents: 300000 });
  D(app, 'POST', '/agreements/ag-1/activate', {});
}

test('bank-account CRUD; a trust account gets its own GL cash account', () => {
  const app = mkApp(); seed(app);
  const r = D(app, 'POST', '/bank-accounts', { code: 'TRUST-01', name: 'Resident Deposits Trust', kind: 'trust' });
  assert.equal(r.status, 201);
  const ba = r.body as { id: string; kind: string; glAccount: string };
  assert.equal(ba.kind, 'trust');
  assert.match(ba.glAccount, /^assets:cash:trust:/);
  assert.equal((D(app, 'GET', '/bank-accounts').body as { bankAccounts: unknown[] }).bankAccounts.length, 1);
});

test('bank-account write needs entity.manage; an accountant can, front-desk cannot', () => {
  const app = mkApp(); seed(app);
  assert.equal(D(app, 'POST', '/bank-accounts', { code: 'OP-1', name: 'Operating', kind: 'operating' }, 'acc').status, 201);
  assert.equal(D(app, 'POST', '/bank-accounts', { code: 'OP-2', name: 'Operating 2' }, 'fd').status, 403);
});

test('with NO trust account, a deposit books to operating cash', () => {
  const app = mkApp(); seed(app);
  D(app, 'POST', '/deposits', { id: 'dep-1', agreementId: 'ag-1', amountCents: 50000 });
  const lines = app.snapshotWorld('mf').journalLines.filter((l) => l.entryId === 'je-dep-hold-dep-1');
  const cash = lines.find((l) => l.debitCents === 50000)!;
  assert.equal(cash.account, 'assets:cash');
});

test('with a trust account, a deposit books to the segregated trust GL', () => {
  const app = mkApp(); seed(app);
  const ba = D(app, 'POST', '/bank-accounts', { code: 'TRUST-01', name: 'Deposits Trust', kind: 'trust' }).body as { glAccount: string };
  D(app, 'POST', '/deposits', { id: 'dep-1', agreementId: 'ag-1', amountCents: 50000 });
  const held = app.snapshotWorld('mf').journalLines.filter((l) => l.entryId === 'je-dep-hold-dep-1');
  const cash = held.find((l) => l.debitCents === 50000)!;
  assert.equal(cash.account, ba.glAccount); // trust cash, NOT assets:cash
  assert.equal(cash.account, 'assets:cash:trust:trust-01');
});

test('a refund returns cash from the SAME (trust) account', () => {
  const app = mkApp(); seed(app);
  const ba = D(app, 'POST', '/bank-accounts', { code: 'TRUST-01', name: 'Deposits Trust', kind: 'trust' }).body as { glAccount: string };
  D(app, 'POST', '/deposits', { id: 'dep-1', agreementId: 'ag-1', amountCents: 50000 });
  D(app, 'POST', '/deposits/dep-1/refund', { deductions: [{ reason: 'cleaning', amountCents: 8000 }] });
  const refundLines = app.snapshotWorld('mf').journalLines.filter((l) => l.entryId === 'je-dep-refund-dep-1');
  const cashOut = refundLines.find((l) => l.creditCents === 42000)!; // 50000 - 8000
  assert.equal(cashOut.account, ba.glAccount);
  // Trial balance still nets to zero.
  assert.equal(app.dispatch({ method: 'GET', path: '/ledger/trial-balance', bearer: 'Bearer own', body: {} }).body && (app.snapshotWorld('mf').journalLines.reduce((n, l) => n + l.debitCents - l.creditCents, 0)), 0);
});

test('the trust GL cash balance is visible separately from operating cash', () => {
  const app = mkApp(); seed(app);
  D(app, 'POST', '/bank-accounts', { code: 'TRUST-01', name: 'Deposits Trust', kind: 'trust' });
  D(app, 'POST', '/deposits', { id: 'dep-1', agreementId: 'ag-1', amountCents: 50000 });
  const tb = D(app, 'GET', '/ledger/trial-balance').body as { balances: Record<string, number> };
  assert.equal(tb.balances['assets:cash:trust:trust-01'], 50000);
  assert.ok(!('assets:cash' in tb.balances) || tb.balances['assets:cash'] === 0);
});

test('projection emits bank_account (after legal_entity) + deposit.cash_account', () => {
  const app = mkApp(); seed(app);
  D(app, 'POST', '/bank-accounts', { code: 'TRUST-01', name: 'Deposits Trust', kind: 'trust' });
  D(app, 'POST', '/deposits', { id: 'dep-1', agreementId: 'ag-1', amountCents: 50000 });
  const stmts = projectWorld(app.snapshotWorld('mf'));
  const order = stmts.map((s) => s.text.match(/^insert into (\w+)/)?.[1] ?? '');
  assert.ok(order.includes('bank_account'));
  const dep = stmts.find((s) => s.text.startsWith('insert into deposit'))!;
  assert.ok(dep.text.includes('cash_account'));
  assert.equal(dep.values[9], 'assets:cash:trust:trust-01');
});

test('trust account + deposit routing survive snapshot → rehydrate', () => {
  const app = mkApp(); seed(app);
  D(app, 'POST', '/bank-accounts', { code: 'TRUST-01', name: 'Deposits Trust', kind: 'trust' });
  D(app, 'POST', '/deposits', { id: 'dep-1', agreementId: 'ag-1', amountCents: 50000 });
  const b = mkApp();
  b.rehydrate(app.snapshotWorld('mf'));
  assert.equal((D(b, 'GET', '/bank-accounts').body as { bankAccounts: unknown[] }).bankAccounts.length, 1);
  // A new deposit in b still routes to the trust account.
  D(b, 'POST', '/deposits', { id: 'dep-2', agreementId: 'ag-1', amountCents: 30000 });
  const cash = b.snapshotWorld('mf').journalLines.filter((l) => l.entryId === 'je-dep-hold-dep-2').find((l) => l.debitCents === 30000)!;
  assert.equal(cash.account, 'assets:cash:trust:trust-01');
});
