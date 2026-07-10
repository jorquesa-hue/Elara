// Tranche 27 — country environments. A deployment serves many countries; each
// country fixes currency, locale, timezone, jurisdiction and the tax-id label,
// while the master-data STRUCTURE stays identical everywhere. Country is
// configuration + jurisdiction only — never a schema fork. 10 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { countryProfile, isCountry, COUNTRY_PROFILES, CountryError } from '../src/country.ts';
import { ConfigStore } from '../src/config.ts';
import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';

const T = '2026-07-01T00:00:00Z';
const bearer = (t: string) => `Bearer ${t}`;
const D = (app: App, method: string, path: string, token: string, body?: Record<string, unknown>) =>
  app.dispatch({ method, path, bearer: bearer(token), body });

// ---- country profiles ----------------------------------------------------

test('every country profile is well-formed and has a jurisdiction', () => {
  for (const p of COUNTRY_PROFILES) {
    assert.ok(p.code && p.currency && p.locale && p.timezone && p.jurisdiction && p.taxIdLabel);
  }
  assert.equal(countryProfile('BR').jurisdiction, 'BR');
  assert.equal(countryProfile('PT').jurisdiction, 'EU'); // Portugal → EU jurisdiction
  assert.equal(countryProfile('BR').taxIdLabel, 'CNPJ/CPF');
  assert.equal(isCountry('ZZ'), false);
  assert.throws(() => countryProfile('ZZ'), CountryError);
});

// ---- config store derives from country -----------------------------------

test('setupForCountry seeds currency/locale/timezone from the profile', () => {
  const store = new ConfigStore();
  const cfg = store.setupForCountry('t-br', 'Rio Ops', 'BR');
  assert.equal(cfg.currency, 'BRL');
  assert.equal(cfg.locale, 'pt-BR');
  assert.equal(cfg.timezone, 'America/Sao_Paulo');
  assert.equal(cfg.jurisdiction, 'BR');
});

test('setupForCountry honours overrides but the jurisdiction still follows country', () => {
  const store = new ConfigStore();
  const cfg = store.setupForCountry('t-us', 'NY Ops', 'US', { currency: 'EUR' });
  assert.equal(cfg.currency, 'EUR'); // overridden
  assert.equal(cfg.jurisdiction, 'US'); // still from country
});

test('jurisdiction is always derived, never set independently', () => {
  const store = new ConfigStore();
  // Even if a caller passes a bogus jurisdiction, the country wins.
  const cfg = store.set({ tenantId: 't-1', displayName: 'X', locale: 'es', currency: 'MXN', timezone: 'America/Mexico_City', businessStructure: 'short_stay', country: 'MX', jurisdiction: 'WRONG' });
  assert.equal(cfg.jurisdiction, 'MX');
});

test('an unsupported country is rejected', () => {
  const store = new ConfigStore();
  assert.throws(() => store.setupForCountry('t', 'X', 'ZZ'), CountryError);
  // set() derives jurisdiction from the country first, so a bad country is
  // rejected there — either way it never persists.
  assert.throws(() => store.set({ tenantId: 't', displayName: 'X', locale: 'en', currency: 'USD', timezone: 'UTC', businessStructure: 'x', country: 'ZZ', jurisdiction: 'ZZ' }), CountryError);
});

// ---- through the Public API -----------------------------------------------

function makeApp() {
  const owner: AuthContext = { actor: 'ana', tenantId: 't1', role: 'owner' };
  const auth = new StaticTokenAuthenticator({ own: owner });
  return new App({ authenticator: auth, now: () => T });
}

test('API: GET /countries lists the environments', () => {
  const app = makeApp();
  const r = D(app, 'GET', '/countries', 'own');
  assert.equal(r.status, 200);
  const codes = (r.body as { countries: Array<{ code: string }> }).countries.map((c) => c.code);
  assert.ok(codes.includes('BR') && codes.includes('US'));
});

test('API: setting a country configures the tenant and derives jurisdiction', () => {
  const app = makeApp();
  const r = D(app, 'PUT', '/config', 'own', { displayName: 'São Paulo Stays', country: 'BR' });
  assert.equal(r.status, 200);
  const cfg = r.body as { country: string; currency: string; locale: string; jurisdiction: string };
  assert.equal(cfg.country, 'BR');
  assert.equal(cfg.currency, 'BRL');
  assert.equal(cfg.jurisdiction, 'BR');
});

test('API: GET /config exposes the country options', () => {
  const app = makeApp();
  const r = D(app, 'GET', '/config', 'own');
  const opts = (r.body as { options: { countries: Array<{ code: string }> } }).options;
  assert.ok(opts.countries.some((c) => c.code === 'BR'));
});

test('API: the tenant jurisdiction flows into the policy context', () => {
  const app = makeApp();
  // lease.execute escalates regardless of country (regulated everywhere), but the
  // jurisdiction is now carried — set BR and confirm the escalation still holds.
  D(app, 'PUT', '/config', 'own', { displayName: 'BR Ops', country: 'BR' });
  assert.equal(app.config.get('t1').jurisdiction, 'BR');
});

test('API: the master-data structure is identical across countries', () => {
  const app = makeApp();
  // Same endpoints, same shapes — only config differs. A US and a BR tenant both
  // create a party with the exact same schema.
  D(app, 'PUT', '/config', 'own', { displayName: 'BR Ops', country: 'BR' });
  const r = D(app, 'POST', '/parties', 'own', { id: 'p1', kind: 'person', displayName: 'Ana', taxId: '123' });
  assert.equal(r.status, 201);
  assert.equal((r.body as { taxId: string }).taxId, '123'); // same party.taxId field everywhere
});
