// Tranche 34 — wiring lease.execute. Legally binding a lease is regulated +
// irreversible, so lease.execute ESCALATES in every jurisdiction: the endpoint
// always parks for human approval and the binding runs only on approve. 6 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';

const T = '2026-07-01T00:00:00Z';
const bearer = (t: string) => `Bearer ${t}`;
const D = (app: App, method: string, path: string, token: string, body?: Record<string, unknown>) =>
  app.dispatch({ method, path, bearer: bearer(token), body });

function makeApp() {
  const mgr: AuthContext = { actor: 'mgr', tenantId: 't1', role: 'manager' };
  const agent: AuthContext = { actor: 'bot', tenantId: 't1', role: 'agent' };
  const auth = new StaticTokenAuthenticator({ mgr, bot: agent });
  return new App({ authenticator: auth, units: [{ id: 'u-1', tenantId: 't1' }], now: () => T });
}

/** A lease-kind, active agreement ready to execute. */
function activeLease(app: App, id = 'ag-1') {
  D(app, 'POST', '/agreements', 'mgr', { id, guestId: 'g-1', unitId: 'u-1', kind: 'nightly', start: '2026-07-01', end: '2026-07-10', rateCents: 20000 });
  D(app, 'POST', `/agreements/${id}/activate`, 'mgr', {});
  D(app, 'POST', `/agreements/${id}/convert`, 'mgr', { to: 'monthly', rateCents: 300000 });
  D(app, 'POST', `/agreements/${id}/convert`, 'mgr', { to: 'lease', rateCents: 300000 });
}

test('executing a lease ESCALATES (202) — never auto-executed, in any jurisdiction', () => {
  const app = makeApp();
  activeLease(app);
  const r = D(app, 'POST', '/agreements/ag-1/execute-lease', 'mgr', { documentRef: 'lease-pdf-1' });
  assert.equal(r.status, 202);
  assert.equal((r.body as { status: string }).status, 'escalated');
  // Not yet bound.
  assert.equal((D(app, 'GET', '/agreements/ag-1', 'mgr').body as { history: unknown[] }).history.some((e: any) => e.type === 'lease_executed'), false);
});

test('a human approving the escalation binds the lease', () => {
  const app = makeApp();
  activeLease(app);
  const esc = D(app, 'POST', '/agreements/ag-1/execute-lease', 'mgr', {});
  const exId = (esc.body as { exceptionId: string }).exceptionId;
  const ap = D(app, 'POST', `/exceptions/${exId}/approve`, 'mgr', {});
  assert.equal(ap.status, 200);
  // Now the binding event exists.
  const hist = (D(app, 'GET', '/agreements/ag-1', 'mgr').body as { history: Array<{ type: string }> }).history;
  assert.ok(hist.some((e) => e.type === 'lease_executed'));
});

test('an agent CANNOT initiate a lease execution (agreement.execute not in OPS)', () => {
  const app = makeApp();
  activeLease(app);
  assert.equal(D(app, 'POST', '/agreements/ag-1/execute-lease', 'bot', {}).status, 403);
});

test('cannot execute a lease on a non-lease agreement', () => {
  const app = makeApp();
  // nightly, active, never converted to a lease
  D(app, 'POST', '/agreements', 'mgr', { id: 'ag-x', guestId: 'g-1', unitId: 'u-1', kind: 'nightly', start: '2026-07-01', end: '2026-07-10', rateCents: 20000 });
  D(app, 'POST', '/agreements/ag-x/activate', 'mgr', {});
  // The escalation parks; approving it surfaces the aggregate's refusal.
  const esc = D(app, 'POST', '/agreements/ag-x/execute-lease', 'mgr', {});
  assert.equal(esc.status, 202);
  const exId = (esc.body as { exceptionId: string }).exceptionId;
  const ap = D(app, 'POST', `/exceptions/${exId}/approve`, 'mgr', {});
  assert.notEqual(ap.status, 200); // the bind throws (wrong kind) on approval
});

test('a second execution after binding is refused on approval (idempotent binding)', () => {
  const app = makeApp();
  activeLease(app);
  const e1 = D(app, 'POST', '/agreements/ag-1/execute-lease', 'mgr', {});
  D(app, 'POST', `/exceptions/${(e1.body as { exceptionId: string }).exceptionId}/approve`, 'mgr', {});
  const e2 = D(app, 'POST', '/agreements/ag-1/execute-lease', 'mgr', {});
  const ap2 = D(app, 'POST', `/exceptions/${(e2.body as { exceptionId: string }).exceptionId}/approve`, 'mgr', {});
  assert.notEqual(ap2.status, 200); // already executed
});

test('the executed lease survives snapshot → rehydrate (event-sourced)', () => {
  const app = makeApp();
  activeLease(app);
  const e = D(app, 'POST', '/agreements/ag-1/execute-lease', 'mgr', { documentRef: 'ref-9' });
  D(app, 'POST', `/exceptions/${(e.body as { exceptionId: string }).exceptionId}/approve`, 'mgr', {});
  const snap = app.snapshotWorld('t1');
  const b = new App({ authenticator: new StaticTokenAuthenticator({ mgr: { actor: 'mgr', tenantId: 't1', role: 'manager' } }), now: () => T });
  b.rehydrate(snap);
  const hist = (b.dispatch({ method: 'GET', path: '/agreements/ag-1', bearer: bearer('mgr') }).body as { history: Array<{ type: string }> }).history;
  assert.ok(hist.some((ev) => ev.type === 'lease_executed'));
});
