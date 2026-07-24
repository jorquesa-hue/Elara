// Tranche 96 — findability groundwork from the front-end audit: the lease LIST
// must be a working screen, not a wall of ids. GET /agreements now folds in
// residentName (party link, guest fallback), unitLabel and the owning
// community (propertyId/propertyName) per row, so the portal can render
// Resident / Unit / Community columns and filter by the top-bar scope.

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
  D(app, 'PUT', '/config', { displayName: 'Meridian', country: 'US' });
  D(app, 'POST', '/demo/seed', { variant: 'portfolio', at: NOW });
  return app;
}

type Row = {
  id: string; residentName?: string; unitLabel?: string;
  propertyId?: string; propertyName?: string;
};

test('the lease list folds resident, unit and community onto every row', () => {
  const app = seeded();
  const rows = (D(app, 'GET', '/agreements').body as { agreements: Row[] }).agreements;
  assert.ok(rows.length >= 500, `portfolio-scale list, got ${rows.length}`);
  const a101 = rows.find((r) => r.id === 'agr-AUR-101')!;
  assert.ok(a101, 'agr-AUR-101 present');
  assert.equal(typeof a101.residentName, 'string');
  assert.ok((a101.residentName ?? '').length > 0, 'resident resolved from the party link');
  assert.equal(a101.unitLabel, 'AUR-101');
  assert.equal(a101.propertyId, 'demo-prop-AUR');
  assert.equal(a101.propertyName, 'Aurora Heights');
  // Every row carries a community, so the portal scope filter loses nothing.
  const withProp = rows.filter((r) => r.propertyId).length;
  assert.equal(withProp, rows.length, 'every lease attributes to a community');
});

test('scope filtering by propertyId partitions the list cleanly', () => {
  const app = seeded();
  const rows = (D(app, 'GET', '/agreements').body as { agreements: Row[] }).agreements;
  const byProp = new Map<string, number>();
  for (const r of rows) byProp.set(r.propertyId!, (byProp.get(r.propertyId!) ?? 0) + 1);
  assert.equal(byProp.size, 3, 'three communities');
  const sum = [...byProp.values()].reduce((a, b) => a + b, 0);
  assert.equal(sum, rows.length, 'partition covers every lease exactly once');
});
