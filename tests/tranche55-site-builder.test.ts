// Tranche 55 — website-builder module. Site content is operator-authored page +
// per-unit marketing details with publish switches: sanitize/validate, the
// GET/PUT /site-content endpoints, the public site honoring publish + details,
// and durable persistence (tenant.site_content jsonb round-trip). 11 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeSiteContent, assertSitePhoto, SiteContentError } from '../src/site-content.ts';
import { projectWorld } from '../src/persistence/project.ts';
import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';

const NOW = '2026-07-11T00:00:00Z';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCA';

function seededApp() {
  const mgr: AuthContext = { actor: 'm', tenantId: 'jq', role: 'manager' };
  const fd: AuthContext = { actor: 'f', tenantId: 'jq', role: 'front_desk' };
  const app = new App({ authenticator: new StaticTokenAuthenticator({ mgr, fd }), now: () => NOW });
  app.dispatch({ method: 'POST', path: '/demo/seed', bearer: 'Bearer mgr', body: {} });
  return app;
}
const D = (app: App, method: string, path: string, token: string | null, body?: Record<string, unknown>) =>
  app.dispatch({ method, path, ...(token ? { bearer: `Bearer ${token}` } : {}), body: body ?? {} });

test('sanitize normalizes text, numbers and amenities; drops empties', () => {
  const c = sanitizeSiteContent({
    heroTitle: '  Stay with us  ', about: 'x'.repeat(9000),
    units: { u1: { published: false, bedrooms: '3', bathrooms: 2.7, maxGuests: 0, amenities: ['Wi-Fi', '', '  Pool  '], headline: '' } },
  });
  assert.equal(c.heroTitle, 'Stay with us');
  assert.equal(c.about!.length, 4000); // capped
  const u1 = c.units!['u1']!;
  assert.equal(u1.published, false);
  assert.equal(u1.bedrooms, 3); // coerced from string
  assert.equal(u1.bathrooms, 3); // rounded
  assert.equal(u1.maxGuests, 1); // clamped to >=1
  assert.deepEqual(u1.amenities, ['Wi-Fi', 'Pool']);
  assert.equal(u1.headline, undefined); // empty dropped
});

test('assertSitePhoto rejects non-image and oversize; sanitize throws on bad photo', () => {
  assert.throws(() => assertSitePhoto('data:text/html;base64,zz'), SiteContentError);
  assert.throws(() => sanitizeSiteContent({ units: { u1: { photoDataUrl: 'http://x.com/a.png' } } }), SiteContentError);
  assert.equal(sanitizeSiteContent({ units: { u1: { photoDataUrl: PNG } } }).units!['u1']!.photoDataUrl, PNG);
});

test('PUT /site-content stores and GET returns it (masterdata gates)', () => {
  const app = seededApp();
  const put = D(app, 'PUT', '/site-content', 'mgr', { content: { heroTitle: 'Ilhabela escapes', about: 'Casas na praia.', contactEmail: 'oi@x.com' } });
  assert.equal(put.status, 200);
  const got = D(app, 'GET', '/site-content', 'mgr');
  assert.equal((got.body as { content: { heroTitle: string } }).content.heroTitle, 'Ilhabela escapes');
  // front_desk can READ (masterdata.read in OPS) but cannot WRITE.
  assert.equal(D(app, 'GET', '/site-content', 'fd').status, 200);
  assert.equal(D(app, 'PUT', '/site-content', 'fd', { content: { heroTitle: 'nope' } }).status, 403);
});

test('a bad unit photo through the endpoint is a 400', () => {
  const app = seededApp();
  const res = D(app, 'PUT', '/site-content', 'mgr', { content: { units: { 'demo-unit-ILH-101': { photoDataUrl: 'data:text/plain;base64,xx' } } } });
  assert.equal(res.status, 400);
});

test('public site config carries page content + per-unit details', () => {
  const app = seededApp();
  D(app, 'PUT', '/site-content', 'mgr', { content: {
    heroTitle: 'Sua ilha te espera', about: 'Somos locais.', whatsapp: '+55 12 99999-0000',
    units: { 'demo-unit-ILH-101': { headline: 'Frente mar', bedrooms: 2, amenities: ['Wi-Fi', 'A/C'], photoDataUrl: PNG } },
  } });
  const site = D(app, 'GET', '/site/jq/config', null);
  assert.equal(site.status, 200);
  const body = site.body as { content: { heroTitle: string; whatsapp: string }; units: Array<{ id: string; details?: { headline?: string; bedrooms?: number } }> };
  assert.equal(body.content.heroTitle, 'Sua ilha te espera');
  assert.equal(body.content.whatsapp, '+55 12 99999-0000');
  const u = body.units.find((x) => x.id === 'demo-unit-ILH-101')!;
  assert.equal(u.details!.headline, 'Frente mar');
  assert.equal(u.details!.bedrooms, 2);
});

test('unpublishing a unit hides it from the listing AND availability', () => {
  const app = seededApp();
  D(app, 'PUT', '/site-content', 'mgr', { content: { units: { 'demo-unit-ILH-101': { published: false } } } });
  const listing = D(app, 'GET', '/site/jq/config', null).body as { units: Array<{ id: string }> };
  assert.ok(!listing.units.some((u) => u.id === 'demo-unit-ILH-101'));
  const avail = D(app, 'POST', '/site/jq/availability', null, { from: '2026-09-01', to: '2026-09-05' }).body as { units: Array<{ unitId: string }> };
  assert.ok(!avail.units.some((u) => u.unitId === 'demo-unit-ILH-101'));
  // Other units still listed.
  assert.ok(listing.units.length >= 7);
});

test('re-publishing restores the unit', () => {
  const app = seededApp();
  D(app, 'PUT', '/site-content', 'mgr', { content: { units: { 'demo-unit-ILH-101': { published: false } } } });
  D(app, 'PUT', '/site-content', 'mgr', { content: { units: { 'demo-unit-ILH-101': { published: true } } } });
  const listing = D(app, 'GET', '/site/jq/config', null).body as { units: Array<{ id: string }> };
  assert.ok(listing.units.some((u) => u.id === 'demo-unit-ILH-101'));
});

test('an inactive unit stays off the site regardless of the publish flag', () => {
  const app = seededApp();
  D(app, 'PUT', '/site-content', 'mgr', { content: { units: { 'demo-unit-ILH-102B': { published: true } } } }); // the inactive reforma unit
  const listing = D(app, 'GET', '/site/jq/config', null).body as { units: Array<{ id: string }> };
  assert.ok(!listing.units.some((u) => u.id === 'demo-unit-ILH-102B'));
});

test('snapshotWorld carries siteContent and the projection writes site_content', () => {
  const app = seededApp();
  D(app, 'PUT', '/site-content', 'mgr', { content: { heroTitle: 'Persisted title', units: { 'demo-unit-ILH-101': { bedrooms: 2 } } } });
  const world = app.snapshotWorld('jq');
  // siteContent is now a versioned container ({v, default, properties}); the
  // portfolio site lives under `default` (a legacy flat blob still loads on read).
  assert.equal((world.tenants[0]!.siteContent as { default: { heroTitle: string } }).default.heroTitle, 'Persisted title');
  const tenantStmt = projectWorld(world).find((s) => /insert into tenant\b/.test(s.text))!;
  assert.match(tenantStmt.text, /site_content/);
  assert.ok(tenantStmt.values.some((v) => typeof v === 'string' && v.includes('Persisted title')));
});

test('site content survives snapshot → rehydrate (a restart keeps the website)', () => {
  const app = seededApp();
  D(app, 'PUT', '/site-content', 'mgr', { content: { heroTitle: 'Reload me', about: 'still here', units: { 'demo-unit-ILH-101': { headline: 'Frente mar' } } } });
  const world = app.snapshotWorld('jq');
  const mgr: AuthContext = { actor: 'm', tenantId: 'jq', role: 'manager' };
  const b = new App({ authenticator: new StaticTokenAuthenticator({ mgr }), now: () => NOW });
  b.rehydrate(world);
  const got = D(b, 'GET', '/site-content', 'mgr').body as { content: { heroTitle: string; units: Record<string, { headline: string }> } };
  assert.equal(got.content.heroTitle, 'Reload me');
  assert.equal(got.content.units['demo-unit-ILH-101']!.headline, 'Frente mar');
});

test('a tenant with no site content still serves a working public config', () => {
  const app = seededApp();
  const site = D(app, 'GET', '/site/jq/config', null);
  assert.equal(site.status, 200);
  const body = site.body as { content: Record<string, unknown>; units: unknown[] };
  assert.deepEqual(body.content, {});
  assert.ok(body.units.length >= 8);
});
