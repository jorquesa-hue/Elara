// Tranche 103 — per-property websites. A tenant has one portfolio "default" site
// plus an independent site per property (its own design, content, units, public
// URL /site/:tenant/p/:code and optional custom domain). Guards the store's
// scoping + container persistence, the public config scoping, and Host routing.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SiteContentStore, normalizeDomain } from '../src/site-content.ts';
import { App, StaticTokenAuthenticator, ConfigStore, RoleRegistry, MasterData } from '../src/index.ts';

function ownerApp() {
  const auth = new StaticTokenAuthenticator({ o: { actor: 'a', tenantId: 'jq', role: 'owner' } });
  const app = new App({ authenticator: auth, config: new ConfigStore(), roles: new RoleRegistry(), masterData: new MasterData() });
  const D = (m: string, p: string, b?: unknown) => app.dispatch({ method: m, path: p, bearer: 'Bearer o', body: (b as Record<string, unknown>) ?? {} });
  D('PUT', '/config', { displayName: 'Harbor Homes', country: 'US' });
  D('POST', '/properties', { code: 'CURRAL', name: 'Praia do Curral' });
  D('POST', '/properties', { code: 'VILA', name: 'Vila' });
  D('POST', '/units', { id: 'u1', code: 'A1', label: 'Curral 1', propertyId: 'prop-curral' });
  D('POST', '/units', { id: 'u2', code: 'B1', label: 'Vila 1', propertyId: 'prop-vila' });
  return { app, D };
}
const pub = (app: App, path: string, body?: unknown) => app.dispatch({ method: path.includes('config') ? 'GET' : 'POST', path, body: (body as Record<string, unknown>) ?? {} });

test('store isolates default vs per-property content', () => {
  const s = new SiteContentStore();
  s.set('t', { heroTitle: 'Portfolio' });
  s.set('t', { heroTitle: 'Curral' }, 'prop-CURRAL');
  assert.equal(s.get('t').heroTitle, 'Portfolio');
  assert.equal(s.get('t', 'prop-CURRAL').heroTitle, 'Curral');
  assert.deepEqual(s.get('t', 'prop-UNKNOWN'), {}); // unset property → empty
  assert.deepEqual(s.propertyIds('t'), ['prop-CURRAL']);
});

test('snapshot is a v2 container; hydrate accepts container AND legacy flat', () => {
  const s = new SiteContentStore();
  s.set('t', { heroTitle: 'Portfolio' });
  s.set('t', { heroTitle: 'Curral', domain: 'curral.example.com' }, 'prop-CURRAL');
  const snap = s.snapshot('t')!;
  assert.equal(snap['v'], 2);

  const round = new SiteContentStore();
  round.hydrate('t', snap);
  assert.equal(round.get('t').heroTitle, 'Portfolio');
  assert.equal(round.get('t', 'prop-CURRAL').heroTitle, 'Curral');

  const legacy = new SiteContentStore();
  legacy.hydrate('t', { heroTitle: 'Old flat site' }); // pre-container blob
  assert.equal(legacy.get('t').heroTitle, 'Old flat site');
});

test('resolveDomain maps a Host header to its tenant + property', () => {
  const s = new SiteContentStore();
  s.set('t', { domain: 'book.acme.com' });
  s.set('t', { domain: 'curral.example.com' }, 'prop-CURRAL');
  assert.deepEqual(s.resolveDomain('book.acme.com'), { tenantId: 't' });
  assert.deepEqual(s.resolveDomain('CURRAL.EXAMPLE.COM'), { tenantId: 't', propertyId: 'prop-CURRAL' });
  assert.equal(s.resolveDomain('nope.com'), undefined);
});

test('normalizeDomain strips scheme/path/port and rejects junk', () => {
  assert.equal(normalizeDomain('https://Book.Acme.com/stay'), 'book.acme.com');
  assert.equal(normalizeDomain('acme.com:8080'), 'acme.com');
  assert.equal(normalizeDomain('not a domain'), undefined);
  assert.equal(normalizeDomain('localhost'), undefined);
});

test('public config scopes to one property; portfolio shows all', () => {
  const { app, D } = ownerApp();
  D('PUT', '/site-content', { content: { heroTitle: 'Harbor portfolio' } });
  D('PUT', '/site-content', { content: { heroTitle: 'Praia do Curral' }, propertyId: 'prop-curral' });

  const all = pub(app, '/site/jq/config').body as { units: Array<{ label: string }>; content: { heroTitle: string } };
  assert.equal(all.units.length, 2);
  assert.equal(all.content.heroTitle, 'Harbor portfolio');

  const curral = pub(app, '/site/jq/config', { property: 'CURRAL' }).body as { units: Array<{ label: string }>; content: { heroTitle: string } };
  assert.equal(curral.units.length, 1);
  assert.equal(curral.units[0]!.label, 'Curral 1');
  assert.equal(curral.content.heroTitle, 'Praia do Curral'); // property content wins
});

test('property content falls back to the portfolio default for unset fields', () => {
  const { app, D } = ownerApp();
  D('PUT', '/site-content', { content: { heroTitle: 'Portfolio', about: 'Shared about copy' } });
  D('PUT', '/site-content', { content: { heroTitle: 'Curral only' }, propertyId: 'prop-curral' });
  const curral = pub(app, '/site/jq/config', { property: 'CURRAL' }).body as { content: { heroTitle: string; about?: string } };
  assert.equal(curral.content.heroTitle, 'Curral only');
  assert.equal(curral.content.about, 'Shared about copy'); // inherited default
});

test('PUT to an unknown property 404s', () => {
  const { app, D } = ownerApp();
  const r = D('PUT', '/site-content', { content: { heroTitle: 'x' }, propertyId: 'prop-NOPE' });
  assert.equal(r.status, 404);
});

test('siteForHost resolves a configured custom domain to tenant + property code', () => {
  const { app, D } = ownerApp();
  D('PUT', '/site-content', { content: { heroTitle: 'Curral', domain: 'stay.curral.com' }, propertyId: 'prop-curral' });
  assert.deepEqual(app.siteForHost('stay.curral.com'), { tenant: 'jq', property: 'CURRAL' });
  assert.equal(app.siteForHost('unmapped.com'), null);
});

test('per-property sites survive snapshot → rehydrate', () => {
  const { app, D } = ownerApp();
  D('PUT', '/site-content', { content: { heroTitle: 'Portfolio' } });
  D('PUT', '/site-content', { content: { heroTitle: 'Curral', domain: 'stay.curral.com' }, propertyId: 'prop-curral' });
  const world = app.snapshotWorld('jq');

  const auth = new StaticTokenAuthenticator({ o: { actor: 'a', tenantId: 'jq', role: 'owner' } });
  const fresh = new App({ authenticator: auth, config: new ConfigStore(), roles: new RoleRegistry(), masterData: new MasterData() });
  fresh.rehydrate(world);
  const curral = fresh.dispatch({ method: 'GET', path: '/site/jq/config', body: { property: 'CURRAL' } }).body as { content: { heroTitle: string } };
  assert.equal(curral.content.heroTitle, 'Curral');
  assert.deepEqual(fresh.siteForHost('stay.curral.com'), { tenant: 'jq', property: 'CURRAL' });
});
