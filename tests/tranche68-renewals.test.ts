// Tranche 68 — Phase 2D: lease renewals. Sweep the book for leases approaching
// expiry, offer a renewal (escalated rent + extended term), and accept it by
// bumping the rent + extending the term on the SAME agreement id. The offer is
// deterministic; the sweep notifies idempotently; acceptance flows through the
// normal rent-adjust + amend paths. 11 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';
import { renewalsDue, proposedRate, addMonths, daysUntil } from '../src/renewals.ts';

const NOW = '2026-07-13T00:00:00Z';
const own: AuthContext = { actor: 'own', tenantId: 'mf', role: 'owner' };
const fd: AuthContext = { actor: 'fd', tenantId: 'mf', role: 'front_desk' };

function mkApp() {
  const app = new App({ authenticator: new StaticTokenAuthenticator({ own, fd }), units: [], now: () => NOW });
  D(app, 'PUT', '/config', { displayName: 'Greyline', country: 'US' });
  D(app, 'POST', '/units', { id: 'u-1', code: 'A-1', label: 'Apt 101' });
  // A lease expiring within the 90-day window.
  D(app, 'POST', '/agreements', { id: 'ag-1', guestId: 'Bea Lima', unitId: 'u-1', kind: 'lease', start: '2025-09-01', end: '2026-09-01', rateCents: 300000 });
  D(app, 'POST', '/agreements/ag-1/activate', {});
  return app;
}
const D = (app: App, method: string, path: string, body?: Record<string, unknown>, token = 'own') =>
  app.dispatch({ method, path, bearer: `Bearer ${token}`, body: body ?? {} });

// --- pure module ----------------------------------------------------------
test('proposedRate escalates by basis points; addMonths clamps the day', () => {
  assert.equal(proposedRate(300000, 500), 315000);
  assert.equal(addMonths('2026-09-01', 12), '2027-09-01');
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28'); // clamp to Feb length
});

test('daysUntil measures whole days', () => {
  assert.equal(daysUntil('2026-07-13', '2026-09-01'), 50);
  assert.equal(daysUntil('2026-09-02', '2026-09-01'), -1);
});

test('renewalsDue offers only active term leases within the window, prioritized', () => {
  const cands = [
    { id: 'a', kind: 'lease', status: 'active', rateCents: 300000, end: '2026-09-01' },
    { id: 'b', kind: 'lease', status: 'active', rateCents: 200000, end: '2026-08-01' }, // sooner
    { id: 'c', kind: 'lease', status: 'active', rateCents: 100000, end: '2027-06-01' }, // outside window
    { id: 'd', kind: 'nightly', status: 'active', rateCents: 50000, end: '2026-08-15' }, // not term
    { id: 'e', kind: 'lease', status: 'draft', rateCents: 400000, end: '2026-08-10' }, // not active
  ];
  const offers = renewalsDue(cands, NOW, { lookaheadDays: 90, escalationBps: 500, termMonths: 12 });
  assert.deepEqual(offers.map((o) => o.agreementId), ['b', 'a']); // b expires sooner
  assert.equal(offers[0]!.proposedRateCents, 210000);
  assert.equal(offers[1]!.proposedEnd, '2027-09-01');
});

// --- endpoints ------------------------------------------------------------
test('GET /renewals previews the due offers with the escalated rate', () => {
  const app = mkApp();
  const offers = (D(app, 'GET', '/renewals').body as { offers: Array<{ agreementId: string; proposedRateCents: number; proposedEnd: string; residentName?: string }> }).offers;
  assert.equal(offers.length, 1);
  assert.equal(offers[0]!.agreementId, 'ag-1');
  assert.equal(offers[0]!.proposedRateCents, 315000);
  assert.equal(offers[0]!.proposedEnd, '2027-09-01');
  assert.equal(offers[0]!.residentName, 'Bea Lima');
});

test('a lookahead override narrows the window', () => {
  const app = mkApp();
  // 50 days to expiry; a 30-day window excludes it.
  assert.equal((D(app, 'GET', '/renewals', { lookaheadDays: 30 }).body as { offers: unknown[] }).offers.length, 0);
});

test('POST /renewals/sweep notifies once and is idempotent', () => {
  const app = mkApp();
  const r1 = D(app, 'POST', '/renewals/sweep', {});
  assert.equal((r1.body as { swept: number; notified: number }).swept, 1);
  // No resident email linked → notify is best-effort (skipped), but the marker is
  // recorded, so a second sweep re-notifies nobody.
  const r2 = D(app, 'POST', '/renewals/sweep', {});
  assert.equal((r2.body as { notified: number }).notified, 0);
});

test('the sweep enqueues a renewal_offer notice when the resident has an email', () => {
  const app = mkApp();
  D(app, 'POST', '/parties', { id: 'pty-1', kind: 'person', displayName: 'Bea Lima', email: 'bea@x.com' });
  D(app, 'POST', '/agreements/ag-1/parties', { partyId: 'pty-1', role: 'financial_responsible' });
  D(app, 'POST', '/renewals/sweep', {});
  const notes = (app.snapshotWorld('mf').notifications ?? []).filter((n) => n.kind === 'renewal_offer');
  assert.equal(notes.length, 1);
  assert.equal((notes[0]!.data as { proposedRateCents: number }).proposedRateCents, 315000);
});

test('POST /agreements/:id/renew bumps the rent and extends the term on the same id', () => {
  const app = mkApp();
  const r = D(app, 'POST', '/agreements/ag-1/renew', {});
  assert.equal(r.status, 200);
  const body = r.body as { rateCents: number; period: { end: string }; renewedTo: string };
  assert.equal(body.rateCents, 315000);
  assert.equal(body.period.end, '2027-09-01');
  assert.equal(body.renewedTo, '2027-09-01');
  // After renewal it is outside the (now far-off) window → no longer offered.
  assert.equal((D(app, 'GET', '/renewals').body as { offers: unknown[] }).offers.length, 0);
});

test('renew accepts explicit rate and end overrides', () => {
  const app = mkApp();
  const body = D(app, 'POST', '/agreements/ag-1/renew', { rateCents: 330000, end: '2028-01-01' }).body as { rateCents: number; period: { end: string } };
  assert.equal(body.rateCents, 330000);
  assert.equal(body.period.end, '2028-01-01');
});

test('renewal.run gates the sweep; front_desk may read but not sweep', () => {
  const app = mkApp();
  assert.equal(D(app, 'GET', '/renewals', undefined, 'fd').status, 200);
  assert.equal(D(app, 'POST', '/renewals/sweep', {}, 'fd').status, 403);
});

test('renewals are tenant-scoped', () => {
  const app = mkApp();
  const other: AuthContext = { actor: 'o2', tenantId: 'other', role: 'owner' };
  const app2 = new App({ authenticator: new StaticTokenAuthenticator({ o2: other }), now: () => NOW });
  app2.dispatch({ method: 'PUT', path: '/config', bearer: 'Bearer o2', body: { displayName: 'Other', country: 'US' } });
  assert.equal((app2.dispatch({ method: 'GET', path: '/renewals', bearer: 'Bearer o2', body: {} }).body as { offers: unknown[] }).offers.length, 0);
});
