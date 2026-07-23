// Tranche 92 — the default (Ilhabela / Brazil) demo seed must leave NO portal
// view empty. The seeder previously populated only the core leasing/finance
// arrays, so Applications, Tours, Insurance, Utilities, Packages, Waitlist,
// Distributions, Capital contributions, Roommates, Reservations, Inbox,
// Reconciliation, Purchasing, Make-ready, Preventive maintenance, E-sign and
// Notifications all opened blank on a fresh workspace. This pins that every
// one of those surfaces has sample data, the ledger still balances, and the
// whole enriched world survives a snapshot -> rehydrate.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';

const NOW = '2026-07-24T00:00:00Z';
const own: AuthContext = { actor: 'own', tenantId: 't', role: 'owner' };
const D = (app: App, method: string, path: string, body?: Record<string, unknown>) =>
  app.dispatch({ method, path, bearer: 'Bearer own', body: body ?? {} });

function seeded() {
  const app = new App({ authenticator: new StaticTokenAuthenticator({ own }), units: [], now: () => NOW });
  D(app, 'PUT', '/config', { displayName: 'Ilhabela', country: 'BR' });
  const res = D(app, 'POST', '/demo/seed', { at: NOW });
  assert.equal(res.status, 201);
  return app;
}

const firstArray = (body: unknown): unknown[] =>
  (Object.values(body as Record<string, unknown>).find(Array.isArray) as unknown[]) ?? [];

const VIEWS: Array<[string, number]> = [
  ['/applications', 1], ['/tours', 1], ['/insurance-policies', 1], ['/utility-bills', 1],
  ['/parcels', 1], ['/waitlist', 3], ['/distributions', 1], ['/contributions', 1],
  ['/prospects', 2], ['/legal-entities', 1], ['/reservations', 1], ['/threads', 1],
  ['/bank-transactions', 1], ['/purchase-orders', 1], ['/budgets', 1], ['/turns', 1],
  ['/pm-schedules', 1], ['/signature-envelopes', 1], ['/notifications', 1], ['/spaces', 1],
];

test('every specialty portal view has demo data on the default seed', () => {
  const app = seeded();
  for (const [path, min] of VIEWS) {
    const r = D(app, 'GET', path);
    assert.equal(r.status, 200, `${path} responds 200`);
    assert.ok(firstArray(r.body).length >= min, `${path} has >= ${min} rows`);
  }
});

test('the enriched seed keeps the ledger balanced and fires the ops insights', () => {
  const app = seeded();
  const tb = D(app, 'GET', '/ledger/trial-balance').body as { balanced: boolean; net: number };
  assert.equal(tb.balanced, true);
  assert.equal(tb.net, 0);
  const codes = ((D(app, 'GET', '/reports/insights').body as { insights: Array<{ code?: string }> }).insights ?? [])
    .map((i) => i.code);
  // The stuck make-ready turn (vacated 10 days ago) and the aging parcel (9 days)
  // and the 3-deep waitlist are all seeded, so their insights must be present.
  for (const c of ['turns_stuck', 'pkg_stale', 'waitlist_demand']) assert.ok(codes.includes(c), `insight ${c} fires`);
});

test('the whole seeded world survives snapshot -> rehydrate', () => {
  const a = seeded();
  const world = a.snapshotWorld('t');
  const b = new App({ authenticator: new StaticTokenAuthenticator({ own }), units: [], now: () => NOW });
  b.rehydrate(world);
  for (const [path, min] of VIEWS) {
    assert.ok(firstArray(D(b, 'GET', path).body).length >= min, `${path} survives rehydrate`);
  }
  const tb = D(b, 'GET', '/ledger/trial-balance').body as { balanced: boolean };
  assert.equal(tb.balanced, true);
});
