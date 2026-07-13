// Tranche 54 — company branding (logo, accent color, tagline). Config validation,
// the PUT /config brand path, exposure on GET /config + the public booking-site
// config, projection to the tenant row, and a snapshot→rehydrate round-trip. 9 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assertBrandLogo, ConfigError } from '../src/config.ts';
import { projectWorld } from '../src/persistence/project.ts';
import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';

const NOW = '2026-07-11T00:00:00Z';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCA',
  BIG = 'data:image/png;base64,' + 'A'.repeat(300 * 1024);
function app() {
  const mgr: AuthContext = { actor: 'm', tenantId: 'jq', role: 'owner' };
  const a = new App({ authenticator: new StaticTokenAuthenticator({ mgr }), now: () => NOW });
  a.dispatch({ method: 'PUT', path: '/config', bearer: 'Bearer mgr', body: { displayName: 'Ilhabela Stays', country: 'BR' } });
  return a;
}
const put = (a: App, body: Record<string, unknown>) => a.dispatch({ method: 'PUT', path: '/config', bearer: 'Bearer mgr', body });

test('assertBrandLogo accepts a data:image URL and an https URL', () => {
  assert.equal(assertBrandLogo(PNG), PNG);
  assert.equal(assertBrandLogo('https://cdn.example.com/logo.svg'), 'https://cdn.example.com/logo.svg');
});

test('assertBrandLogo rejects non-image URLs and oversize logos', () => {
  assert.throws(() => assertBrandLogo('data:text/html;base64,abc'), ConfigError);
  assert.throws(() => assertBrandLogo('http://insecure.example.com/x.png'), ConfigError);
  assert.throws(() => assertBrandLogo(BIG), ConfigError);
});

test('PUT /config sets brand color, logo and tagline', () => {
  const a = app();
  const res = put(a, { brandColor: '#ff5a5f', logoDataUrl: PNG, tagline: 'Beachfront bliss' });
  assert.equal(res.status, 200);
  const cfg = res.body as { brandColor: string; logoDataUrl: string; tagline: string };
  assert.equal(cfg.brandColor, '#ff5a5f');
  assert.equal(cfg.logoDataUrl, PNG);
  assert.equal(cfg.tagline, 'Beachfront bliss');
});

test('branding is orthogonal to other config (a currency change keeps the brand)', () => {
  const a = app();
  put(a, { brandColor: '#123456', tagline: 'Stay awhile' });
  const res = put(a, { displayName: 'Ilhabela Stays', locale: 'pt-BR', currency: 'BRL', timezone: 'America/Sao_Paulo', businessStructure: 'mixed_portfolio' });
  const cfg = res.body as { brandColor?: string; tagline?: string; currency: string };
  assert.equal(cfg.currency, 'BRL');
  assert.equal(cfg.brandColor, '#123456'); // untouched
  assert.equal(cfg.tagline, 'Stay awhile');
});

test('a bad logo is rejected with 400, not silently stored', () => {
  const a = app();
  assert.equal(put(a, { logoDataUrl: 'data:text/html;base64,zz' }).status, 400);
});

test('an empty string clears a brand field', () => {
  const a = app();
  put(a, { brandColor: '#abcabc', tagline: 'x' });
  const res = put(a, { brandColor: '', tagline: '' });
  const cfg = res.body as { brandColor?: string; tagline?: string };
  assert.equal(cfg.brandColor, undefined);
  assert.equal(cfg.tagline, undefined);
});

test('GET /config surfaces the brand to the operator portal', () => {
  const a = app();
  put(a, { brandColor: '#0a7', logoDataUrl: PNG, tagline: 'Sun & sea' });
  const cfg = (a.dispatch({ method: 'GET', path: '/config', bearer: 'Bearer mgr', body: {} }).body as { config: { brandColor: string; tagline: string } }).config;
  assert.equal(cfg.brandColor, '#0a7');
  assert.equal(cfg.tagline, 'Sun & sea');
});

test('the public booking-site config carries the brand (color, logo, tagline)', () => {
  const a = app();
  a.dispatch({ method: 'POST', path: '/demo/seed', bearer: 'Bearer mgr', body: {} });
  put(a, { brandColor: '#e0894a', logoDataUrl: PNG, tagline: 'Your island escape' });
  const site = a.dispatch({ method: 'GET', path: '/site/jq/config', body: {} }); // public, no bearer
  assert.equal(site.status, 200);
  const brand = (site.body as { brand: { color: string; logoDataUrl: string; tagline: string } }).brand;
  assert.equal(brand.color, '#e0894a');
  assert.equal(brand.logoDataUrl, PNG);
  assert.equal(brand.tagline, 'Your island escape');
});

test('brand projects to the tenant row and survives snapshot→rehydrate', () => {
  const a = app();
  put(a, { brandColor: '#334455', logoDataUrl: PNG, tagline: 'Round trip' });
  const world = a.snapshotWorld('jq');
  assert.equal(world.tenants[0]!.brandColor, '#334455');
  // The projection writes the brand columns.
  const stmts = projectWorld(world);
  const tenantStmt = stmts.find((s) => /insert into tenant\b/.test(s.text))!;
  assert.match(tenantStmt.text, /brand_color/);
  assert.ok(tenantStmt.values.includes('#334455'));
  // Rehydrate into a fresh App and confirm the brand reloaded.
  const mgr: AuthContext = { actor: 'm', tenantId: 'jq', role: 'owner' };
  const b = new App({ authenticator: new StaticTokenAuthenticator({ mgr }), now: () => NOW });
  b.rehydrate(world);
  const cfg = (b.dispatch({ method: 'GET', path: '/config', bearer: 'Bearer mgr', body: {} }).body as { config: { brandColor: string; tagline: string } }).config;
  assert.equal(cfg.brandColor, '#334455');
  assert.equal(cfg.tagline, 'Round trip');
});
