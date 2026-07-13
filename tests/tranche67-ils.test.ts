// Tranche 67 — Phase 2C: ILS syndication. Syndicate the published listing feed
// (the same inventory the booking site serves) to an internet listing service
// via the connector framework — a credential-free push_listings command — and
// take prospects back through the inbound events port (ils.lead_created → a
// pipeline lead source='ils'). 10 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';
import { KIND_ACTIONS, KIND_EVENTS, isKnownAction, isKnownEvent } from '../src/integration-contract.ts';
import { planConnectorCommand } from '../src/connector-adapters.ts';

const NOW = '2026-07-13T00:00:00Z';
const own: AuthContext = { actor: 'own', tenantId: 'mf', role: 'owner' };

function mkApp() {
  const app = new App({ authenticator: new StaticTokenAuthenticator({ own }), units: [], now: () => NOW });
  D(app, 'PUT', '/config', { displayName: 'Greyline Living', country: 'US' });
  D(app, 'POST', '/unit-types', { id: 'ut-1', code: '1BR', name: 'One Bedroom', bedrooms: 1, bathrooms: 1, baseRentCents: 250000 });
  D(app, 'POST', '/units', { id: 'u-1', code: 'A-1', label: 'Apt 101', typeId: 'ut-1' });
  D(app, 'POST', '/units', { id: 'u-2', code: 'A-2', label: 'Apt 102', typeId: 'ut-1' });
  return app;
}
const D = (app: App, method: string, path: string, body?: Record<string, unknown>, token = 'own') =>
  app.dispatch({ method, path, bearer: `Bearer ${token}`, body: body ?? {} });

function connectIls(app: App) {
  return D(app, 'POST', '/integrations', { id: 'int-ils', kind: 'ils', provider: 'generic_rest', secretRef: 'ils-key', config: { baseUrl: 'https://ils.example' } });
}

// --- contract -------------------------------------------------------------
test('ils is a known kind with push_listings + lead_created in its contract', () => {
  assert.ok(KIND_ACTIONS.ils.some((a) => a.action === 'push_listings'));
  assert.ok(isKnownAction('ils', 'push_listings'));
  assert.ok(isKnownEvent('ils', 'lead_created'));
  assert.equal(KIND_EVENTS.ils.includes('listing_published'), true);
});

test('ils routing dispatches (not a money rail) when the secret is resolved', () => {
  assert.equal(planConnectorCommand({ action: 'push_listings', kind: 'ils', secretResolved: true, payload: {} }).decision, 'dispatch');
  assert.equal(planConnectorCommand({ action: 'push_listings', kind: 'ils', secretResolved: false, payload: {} }).decision, 'reject');
});

// --- feed -----------------------------------------------------------------
test('GET /ils/feed builds a listing feed from the published inventory', () => {
  const app = mkApp();
  const feed = D(app, 'GET', '/ils/feed').body as { operator: string; listings: Array<{ unitId: string; bedrooms?: number; fromCents: number | null; floorplan?: string }> };
  assert.equal(feed.operator, 'Greyline Living');
  assert.equal(feed.listings.length, 2);
  const l = feed.listings.find((x) => x.unitId === 'u-1')!;
  assert.equal(l.bedrooms, 1);
  assert.equal(l.floorplan, 'One Bedroom');
  assert.equal(l.fromCents, 250000); // falls back to the floorplan market rent
});

test('GET /ils/feed 409s when there is no inventory', () => {
  const app = new App({ authenticator: new StaticTokenAuthenticator({ own }), now: () => NOW });
  D(app, 'PUT', '/config', { displayName: 'Empty', country: 'US' });
  assert.equal(D(app, 'GET', '/ils/feed').status, 409);
});

// --- syndicate ------------------------------------------------------------
test('POST /ils/:id/syndicate enqueues a credential-free push_listings command', () => {
  const app = mkApp();
  connectIls(app);
  const r = D(app, 'POST', '/ils/int-ils/syndicate', {});
  assert.equal(r.status, 202);
  assert.equal((r.body as { listingCount: number }).listingCount, 2);
  const cmds = (app.snapshotWorld('mf').connectorCommands ?? []).filter((c) => c.action === 'push_listings');
  assert.equal(cmds.length, 1);
  // The command carries the adapter request template but NEVER the secret.
  const json = JSON.stringify(cmds[0]!.payload);
  assert.ok(/_request/.test(json));
  assert.equal(/ils-key/.test(json), false);
});

test('syndicate refuses a non-ils integration and an inactive one', () => {
  const app = mkApp();
  D(app, 'POST', '/integrations', { id: 'int-web', kind: 'website', provider: 'generic_webhook', secretRef: 'k' });
  assert.equal(D(app, 'POST', '/ils/int-web/syndicate', {}).status, 400);
  connectIls(app);
  D(app, 'POST', '/integrations/int-ils/status', { status: 'disabled' });
  assert.equal(D(app, 'POST', '/ils/int-ils/syndicate', {}).status, 409);
});

test('an unknown integration 404s', () => {
  const app = mkApp();
  assert.equal(D(app, 'POST', '/ils/nope/syndicate', {}).status, 404);
});

// --- inbound leads --------------------------------------------------------
test('an ils lead_created event lands a pipeline lead tagged source=ils', () => {
  const app = mkApp();
  connectIls(app);
  const r = D(app, 'POST', '/integrations/int-ils/events', { event: 'lead_created', eventId: 'e1', payload: { name: 'Dana Prospect', estValueCents: 240000 } });
  assert.equal(r.status, 201);
  const leadId = (r.body as { id: string }).id;
  const lead = D(app, 'GET', '/leads/' + leadId).body as { name: string; source: string };
  assert.equal(lead.name, 'Dana Prospect');
  assert.equal(lead.source, 'ils');
});

test('a re-delivered ils event is idempotent', () => {
  const app = mkApp();
  connectIls(app);
  D(app, 'POST', '/integrations/int-ils/events', { event: 'lead_created', eventId: 'e1', payload: { name: 'Dana' } });
  assert.equal(D(app, 'POST', '/integrations/int-ils/events', { event: 'lead_created', eventId: 'e1', payload: { name: 'Dana' } }).status, 200);
});

test('the ils capability shows in GET /integrations/capabilities', () => {
  const app = mkApp();
  const contract = (D(app, 'GET', '/integrations/capabilities').body as { contract: Array<{ kind: string }> }).contract;
  assert.ok(contract.some((c) => c.kind === 'ils'));
});
