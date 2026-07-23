// Tranche 86 — the European multi-portfolio demo (Meridian Living): four
// communities (Berlin MF+short-stay, Munich MF long-lease, Amsterdam MF+short-stay,
// a Berlin student campus) seeded through the normal kernel path. Asserts it
// applies, balances, spans the modules, and is idempotent + tenant-scoped.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';

const NOW = '2026-07-20T00:00:00Z';
const own: AuthContext = { actor: 'own', tenantId: 'mer', role: 'owner' };
const D = (app: App, method: string, path: string, body?: Record<string, unknown>) =>
  app.dispatch({ method, path, bearer: 'Bearer own', body: body ?? {} });

function mkApp() {
  const app = new App({ authenticator: new StaticTokenAuthenticator({ own }), units: [], now: () => NOW });
  D(app, 'PUT', '/config', { displayName: 'Meridian Living', country: 'GB' });
  return app;
}

test('the europe variant seeds four communities across the modules and balances', () => {
  const app = mkApp();
  const r = D(app, 'POST', '/demo/seed', { variant: 'europe', at: NOW });
  assert.equal(r.status, 201);
  const b = r.body as { seeded: boolean; counts: Record<string, number> };
  assert.equal(b.seeded, true);
  assert.equal(b.counts.agreements, 12);
  assert.ok((b.counts.invoices ?? 0) >= 12 && (b.counts.bills ?? 0) >= 4 && (b.counts.workOrders ?? 0) >= 4 && (b.counts.leads ?? 0) >= 6);
  // Four communities.
  const props = (D(app, 'GET', '/properties').body as { properties: unknown[] }).properties;
  assert.equal(props.length, 4);
  // Ledger balances after all the seeded money movement.
  assert.equal((D(app, 'GET', '/ledger/trial-balance').body as { balanced: boolean }).balanced, true);
  // Some cash was collected (payments recorded).
  assert.ok((b.counts.payments ?? 0) >= 5);
});

test('the europe seed is idempotent (re-seeding does nothing)', () => {
  const app = mkApp();
  assert.equal((D(app, 'POST', '/demo/seed', { variant: 'europe' }).body as { seeded: boolean }).seeded, true);
  assert.equal((D(app, 'POST', '/demo/seed', { variant: 'europe' }).body as { seeded: boolean }).seeded, false);
});

test('europe and the default Ilhabela seed can coexist (distinct markers)', () => {
  const app = mkApp();
  assert.equal((D(app, 'POST', '/demo/seed', { variant: 'europe' }).body as { seeded: boolean }).seeded, true);
  assert.equal((D(app, 'POST', '/demo/seed', {}).body as { seeded: boolean }).seeded, true); // Ilhabela too
  assert.equal((D(app, 'GET', '/properties').body as { properties: unknown[] }).properties.length, 6); // 4 + 2
});

test('a rent roll over the seeded europe portfolio shows occupied units with residents', () => {
  const app = mkApp();
  D(app, 'POST', '/demo/seed', { variant: 'europe', at: NOW });
  const rep = D(app, 'GET', '/reports/rent_roll').body as { report: { rows: Array<{ resident?: string; status: string }> } };
  const occupied = rep.report.rows.filter((r) => r.status === 'occupied');
  assert.ok(occupied.length >= 8, 'most units are occupied');
  assert.ok(occupied.some((r) => (r.resident || '').includes('Anna Schmidt')), 'a named resident appears');
});
