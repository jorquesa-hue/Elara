// Tranche 19 — Phase 2 module 5: bank reconciliation (#5), AR & AP. Bank lines
// are imported and matched to the payments the ledger already knows about;
// suggestMatches() is a pure, deterministic ranker (the AI seam). 11 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';
import { suggestMatches } from '../src/reconciliation.ts';
import { ACCOUNTS } from '../src/billing.ts';

const T = '2026-07-01T00:00:00Z';
const bearer = (t: string) => `Bearer ${t}`;
const D = (app: App, method: string, path: string, token: string, body?: Record<string, unknown>) =>
  app.dispatch({ method, path, bearer: bearer(token), body });

// --- pure ranker -----------------------------------------------------------
test('suggestMatches ranks exact-amount candidates by date proximity', () => {
  const cands = [
    { type: 'payment' as const, id: 'near', amountCents: 80000, at: '2026-07-02T00:00:00Z' },
    { type: 'payment' as const, id: 'far', amountCents: 80000, at: '2026-07-05T00:00:00Z' },
    { type: 'payment' as const, id: 'wrong', amountCents: 79999, at: '2026-07-02T00:00:00Z' },
    { type: 'payment' as const, id: 'stale', amountCents: 80000, at: '2026-08-01T00:00:00Z' },
  ];
  const out = suggestMatches({ amountCents: 80000, postedAt: '2026-07-02T00:00:00Z' }, cands);
  assert.deepEqual(out.map((s) => s.candidate.id), ['near', 'far']); // wrong amount + out-of-window dropped
  assert.ok(out[0]!.score > out[1]!.score);
});

// --- through the API -------------------------------------------------------
function makeApp() {
  const owner: AuthContext = { actor: 'ana', tenantId: 't1', role: 'owner' };
  const acct: AuthContext = { actor: 'fin', tenantId: 't1', role: 'accountant' };
  const agent: AuthContext = { actor: 'bot', tenantId: 't1', role: 'agent' };
  const reader: AuthContext = { actor: 'aud', tenantId: 't1', role: 'read_only' };
  const other: AuthContext = { actor: 'sp', tenantId: 't2', role: 'owner' };
  const auth = new StaticTokenAuthenticator({ own: owner, fin: acct, bot: agent, ro: reader, sp: other });
  const app = new App({ authenticator: auth, units: [{ id: 'u-1', tenantId: 't1' }], now: () => T });
  // An AR receipt: book → activate → invoice → pay R$800.
  D(app, 'POST', '/agreements', 'own', { id: 'ag-1', guestId: 'g-1', unitId: 'u-1', kind: 'monthly', start: '2026-07-01', end: '2027-07-01', rateCents: 80000 });
  D(app, 'POST', '/agreements/ag-1/activate', 'own', {});
  D(app, 'POST', '/invoices', 'own', { id: 'inv-1', agreementId: 'ag-1', dueAt: '2026-07-05', lines: [{ description: 'rent', account: ACCOUNTS.roomRevenue, amountCents: 80000 }] });
  D(app, 'POST', '/payments', 'own', { id: 'pay-1', invoiceId: 'inv-1', amountCents: 80000, method: 'pix' });
  // An AP payout: vendor bill R$250, paid.
  D(app, 'POST', '/parties', 'own', { id: 'v-1', kind: 'organization', displayName: 'Acme' });
  D(app, 'POST', '/bills', 'own', { id: 'b-1', payeeId: 'v-1', dueAt: '2026-07-10', lines: [{ description: 'fix', account: 'expenses:supplier', amountCents: 25000 }] });
  D(app, 'POST', '/bills/b-1/pay', 'own', { id: 'ap-1', amountCents: 25000, method: 'pix' });
  return app;
}

test('an imported bank inflow suggests the matching AR payment', () => {
  const app = makeApp();
  assert.equal(D(app, 'POST', '/bank-transactions', 'own', { id: 'bt-in', amountCents: 80000, postedAt: '2026-07-02T00:00:00Z', description: 'PIX received' }).status, 201);
  const view = D(app, 'GET', '/bank-transactions/bt-in', 'own').body as { suggestions: Array<{ candidate: { type: string; id: string } }> };
  assert.equal(view.suggestions[0]!.candidate.type, 'payment');
  assert.equal(view.suggestions[0]!.candidate.id, 'pay-1');
});

test('a bank outflow suggests the matching AP payment (negative amount)', () => {
  const app = makeApp();
  D(app, 'POST', '/bank-transactions', 'own', { id: 'bt-out', amountCents: -25000, postedAt: '2026-07-01T00:00:00Z', description: 'vendor payout' });
  const view = D(app, 'GET', '/bank-transactions/bt-out', 'own').body as { suggestions: Array<{ candidate: { type: string; id: string } }> };
  assert.equal(view.suggestions[0]!.candidate.type, 'ap_payment');
  assert.equal(view.suggestions[0]!.candidate.id, 'ap-1');
});

test('matching links the bank line; suggestions clear once matched', () => {
  const app = makeApp();
  D(app, 'POST', '/bank-transactions', 'own', { id: 'bt-in', amountCents: 80000, postedAt: '2026-07-02T00:00:00Z', description: 'x' });
  const m = D(app, 'POST', '/bank-transactions/bt-in/match', 'own', { targetType: 'payment', targetId: 'pay-1' });
  assert.equal((m.body as { status: string; matchedId: string }).status, 'matched');
  assert.equal((m.body as { matchedId: string }).matchedId, 'pay-1');
  const view = D(app, 'GET', '/bank-transactions/bt-in', 'own').body as { suggestions: unknown[] };
  assert.equal(view.suggestions.length, 0);
});

test('matching a non-existent payment is 404', () => {
  const app = makeApp();
  D(app, 'POST', '/bank-transactions', 'own', { id: 'bt-in', amountCents: 80000, postedAt: '2026-07-02T00:00:00Z', description: 'x' });
  assert.equal(D(app, 'POST', '/bank-transactions/bt-in/match', 'own', { targetType: 'payment', targetId: 'ghost' }).status, 404);
});

test('unmatch reverts to unmatched; a matched line cannot be ignored until unmatched', () => {
  const app = makeApp();
  D(app, 'POST', '/bank-transactions', 'own', { id: 'bt-in', amountCents: 80000, postedAt: '2026-07-02T00:00:00Z', description: 'x' });
  D(app, 'POST', '/bank-transactions/bt-in/match', 'own', { targetType: 'payment', targetId: 'pay-1' });
  assert.equal(D(app, 'POST', '/bank-transactions/bt-in/ignore', 'own', {}).status, 409);
  assert.equal((D(app, 'POST', '/bank-transactions/bt-in/unmatch', 'own', {}).body as { status: string }).status, 'unmatched');
  assert.equal((D(app, 'POST', '/bank-transactions/bt-in/ignore', 'own', {}).body as { status: string }).status, 'ignored');
});

test('summary counts unmatched/matched/ignored and the unmatched total', () => {
  const app = makeApp();
  D(app, 'POST', '/bank-transactions', 'own', { id: 'bt-1', amountCents: 80000, postedAt: '2026-07-02T00:00:00Z', description: 'a' });
  D(app, 'POST', '/bank-transactions', 'own', { id: 'bt-2', amountCents: -25000, postedAt: '2026-07-02T00:00:00Z', description: 'b' });
  D(app, 'POST', '/bank-transactions/bt-1/match', 'own', { targetType: 'payment', targetId: 'pay-1' });
  const s = D(app, 'GET', '/reconciliation/summary', 'own').body as { total: number; matched: number; unmatched: number; unmatchedAmountCents: number };
  assert.equal(s.total, 2);
  assert.equal(s.matched, 1);
  assert.equal(s.unmatched, 1);
  assert.equal(s.unmatchedAmountCents, -25000);
});

test('zero-amount import is rejected', () => {
  const app = makeApp();
  assert.equal(D(app, 'POST', '/bank-transactions', 'own', { id: 'bt-0', amountCents: 0, postedAt: '2026-07-02T00:00:00Z', description: 'x' }).status, 409);
});

test('reconciliation is a finance function: accountant yes, agent no', () => {
  const app = makeApp();
  assert.equal(D(app, 'POST', '/bank-transactions', 'fin', { id: 'bt-f', amountCents: 80000, postedAt: '2026-07-02T00:00:00Z', description: 'x' }).status, 201);
  assert.equal(D(app, 'POST', '/bank-transactions', 'bot', { id: 'bt-b', amountCents: 80000, postedAt: '2026-07-02T00:00:00Z', description: 'x' }).status, 403);
});

test('read_only can read reconciliation but cannot import', () => {
  const app = makeApp();
  D(app, 'POST', '/bank-transactions', 'own', { id: 'bt-1', amountCents: 80000, postedAt: '2026-07-02T00:00:00Z', description: 'x' });
  assert.equal(D(app, 'GET', '/reconciliation/summary', 'ro').status, 200);
  assert.equal(D(app, 'POST', '/bank-transactions', 'ro', { id: 'bt-r', amountCents: 1, postedAt: T, description: 'x' }).status, 403);
});

test('bank transactions are tenant-scoped', () => {
  const app = makeApp();
  D(app, 'POST', '/bank-transactions', 'own', { id: 'bt-1', amountCents: 80000, postedAt: '2026-07-02T00:00:00Z', description: 'x' });
  assert.equal(D(app, 'GET', '/bank-transactions/bt-1', 'sp').status, 404);
  assert.equal((D(app, 'GET', '/bank-transactions', 'sp').body as { transactions: unknown[] }).transactions.length, 0);
});
