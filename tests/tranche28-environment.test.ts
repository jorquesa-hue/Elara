// Tranche 28 — country environments over one identical structure. Each country
// gets its own setup (config + jurisdiction + jurisdiction-scoped policy); the
// master-data STRUCTURE is byte-for-byte the same everywhere. Provisioning BR vs
// US is the same schema + kernel with a different EnvironmentBlueprint. 12 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildEnvironment, MASTER_DATA_STRUCTURE } from '../src/environment.ts';
import { effectiveRulesFor, PolicyEnvelope } from '../src/policy-envelope.ts';
import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';
import { ACCOUNTS } from '../src/billing.ts';

const T = '2026-07-01T00:00:00Z';
const bearer = (t: string) => `Bearer ${t}`;
const D = (app: App, method: string, path: string, token: string, body?: Record<string, unknown>) =>
  app.dispatch({ method, path, bearer: bearer(token), body });

// ---- blueprint: config differs, structure is identical --------------------

test('BR and US environments differ in config + jurisdiction', () => {
  const br = buildEnvironment('BR');
  const us = buildEnvironment('US');
  assert.equal(br.jurisdiction, 'BR');
  assert.equal(br.config.currency, 'BRL');
  assert.equal(br.taxIdLabel, 'CNPJ/CPF');
  assert.equal(us.jurisdiction, 'US');
  assert.equal(us.config.currency, 'USD');
  assert.equal(us.taxIdLabel, 'EIN/SSN');
});

test('the master-data STRUCTURE is byte-for-byte identical across countries', () => {
  const br = buildEnvironment('BR');
  const us = buildEnvironment('US');
  const pt = buildEnvironment('PT');
  assert.deepEqual(br.masterDataStructure, us.masterDataStructure);
  assert.deepEqual(br.masterDataStructure, pt.masterDataStructure);
  assert.deepEqual([...br.masterDataStructure], [...MASTER_DATA_STRUCTURE]);
});

test('PT and ES share the EU jurisdiction but keep their own config', () => {
  const pt = buildEnvironment('PT');
  const es = buildEnvironment('ES');
  assert.equal(pt.jurisdiction, 'EU');
  assert.equal(es.jurisdiction, 'EU');
  assert.equal(es.config.locale, 'es');
  assert.equal(pt.config.timezone, 'Europe/Lisbon');
});

test('overrides win but the structure and jurisdiction do not move', () => {
  const br = buildEnvironment('BR', { currency: 'USD' });
  assert.equal(br.config.currency, 'USD'); // overridden
  assert.equal(br.jurisdiction, 'BR'); // fixed by country
  assert.deepEqual([...br.masterDataStructure], [...MASTER_DATA_STRUCTURE]);
});

// ---- effective policy diverges per jurisdiction from ONE source -----------

test('the BR/EU deposit cap is in the effective policy for BR + EU, not US', () => {
  const brRules = effectiveRulesFor('BR');
  const usRules = effectiveRulesFor('US');
  const euRules = effectiveRulesFor('EU');
  assert.ok(brRules.some((r) => r.id === 'pol-deposit-hold-cap'));
  assert.ok(euRules.some((r) => r.id === 'pol-deposit-hold-cap'));
  assert.ok(!usRules.some((r) => r.id === 'pol-deposit-hold-cap'));
  assert.equal(usRules.length + 1, brRules.length); // US = BR minus the one scoped rule
});

test('decide() escalates a large deposit in BR but allows it in US', () => {
  const env = new PolicyEnvelope();
  const big = { actor: 'a', amountCents: 1_000_000 };
  assert.equal(env.decide('deposit.hold', { ...big, jurisdiction: 'BR' }).effect, 'escalate');
  assert.equal(env.decide('deposit.hold', { ...big, jurisdiction: 'EU' }).effect, 'escalate');
  assert.equal(env.decide('deposit.hold', { ...big, jurisdiction: 'US' }).effect, 'allow');
  // a small deposit is routine even in BR (below the cap)
  assert.equal(env.decide('deposit.hold', { actor: 'a', amountCents: 50_000, jurisdiction: 'BR' }).effect, 'allow');
});

test('lease.execute stays escalate in every jurisdiction (regulated everywhere)', () => {
  const env = new PolicyEnvelope();
  for (const j of ['BR', 'US', 'EU', 'MX', 'GB']) {
    assert.equal(env.decide('lease.execute', { actor: 'a', jurisdiction: j }).effect, 'escalate');
  }
});

// ---- through the Public API ------------------------------------------------

function makeApp() {
  const owner: AuthContext = { actor: 'ana', tenantId: 't1', role: 'owner' };
  const usOwner: AuthContext = { actor: 'bob', tenantId: 't2', role: 'owner' };
  const auth = new StaticTokenAuthenticator({ own: owner, us: usOwner });
  return new App({ authenticator: auth, now: () => T });
}

test('API: GET /environment returns the tenant country blueprint', () => {
  const app = makeApp();
  D(app, 'PUT', '/config', 'own', { displayName: 'BR Ops', country: 'BR' });
  const r = D(app, 'GET', '/environment', 'own');
  assert.equal(r.status, 200);
  const env = r.body as { country: string; jurisdiction: string; masterDataStructure: string[]; policy: unknown[] };
  assert.equal(env.country, 'BR');
  assert.equal(env.jurisdiction, 'BR');
  assert.ok(env.masterDataStructure.includes('party') && env.masterDataStructure.includes('agreement'));
});

test('API: first-time country setup applies, but CHANGING an established jurisdiction escalates', () => {
  const app = makeApp();
  // First-time setup is provisioning, not a change → applies directly.
  assert.equal(D(app, 'PUT', '/config', 'own', { displayName: 'BR Ops', country: 'BR' }).status, 200);
  // A same-jurisdiction reconfigure (BR→PT is BR→EU, different) escalates; a pure
  // non-country tweak does not. Switching BR→US weakens the deposit cap → escalate.
  const change = D(app, 'PUT', '/config', 'own', { country: 'US' });
  assert.equal(change.status, 202);
  assert.equal((change.body as { status: string }).status, 'escalated');
  // The jurisdiction did NOT change (parked for approval): still BR.
  assert.equal((D(app, 'GET', '/environment', 'own').body as { jurisdiction: string }).jurisdiction, 'BR');
});

test('API: a BR tenant escalates a deposit above the cap; a US tenant does not', () => {
  const app = makeApp();
  // Two SEPARATE tenants, each set up in its own country — the realistic shape
  // (a jurisdiction is fixed at setup; changing an established one now escalates).
  D(app, 'PUT', '/config', 'own', { displayName: 'BR Ops', country: 'BR' });
  D(app, 'POST', '/agreements', 'own', { id: 'ag-1', guestId: 'g-1', unitId: 'u-1', kind: 'lease', start: '2026-07-01', end: '2027-07-01', rateCents: 300000 });
  D(app, 'POST', '/agreements/ag-1/activate', 'own', {});
  const brBig = D(app, 'POST', '/deposits', 'own', { id: 'dep-1', agreementId: 'ag-1', amountCents: 1_000_000 });
  assert.equal(brBig.status, 202); // escalated under BR jurisdiction
  assert.equal((brBig.body as { status: string }).status, 'escalated');

  // Same action, same amount, a US-environment tenant → routine.
  D(app, 'PUT', '/config', 'us', { displayName: 'US Ops', country: 'US' });
  D(app, 'POST', '/agreements', 'us', { id: 'ag-2', guestId: 'g-2', unitId: 'u-2', kind: 'lease', start: '2026-07-01', end: '2027-07-01', rateCents: 300000 });
  D(app, 'POST', '/agreements/ag-2/activate', 'us', {});
  const usBig = D(app, 'POST', '/deposits', 'us', { id: 'dep-2', agreementId: 'ag-2', amountCents: 1_000_000 });
  assert.equal(usBig.status, 201); // allowed under US jurisdiction
});

test('API: the master-data structure is the SAME regardless of country', () => {
  const app = makeApp();
  D(app, 'PUT', '/config', 'own', { displayName: 'BR', country: 'BR' });
  const brEnv = D(app, 'GET', '/environment', 'own').body as { masterDataStructure: string[] };
  D(app, 'PUT', '/config', 'own', { displayName: 'US', country: 'US' });
  const usEnv = D(app, 'GET', '/environment', 'own').body as { masterDataStructure: string[] };
  assert.deepEqual(brEnv.masterDataStructure, usEnv.masterDataStructure);
});

test('API: a small deposit is routine even for a BR tenant', () => {
  const app = makeApp();
  D(app, 'PUT', '/config', 'own', { displayName: 'BR Ops', country: 'BR' });
  D(app, 'POST', '/agreements', 'own', { id: 'ag-1', guestId: 'g-1', unitId: 'u-1', kind: 'lease', start: '2026-07-01', end: '2027-07-01', rateCents: 300000 });
  D(app, 'POST', '/agreements/ag-1/activate', 'own', {});
  assert.equal(D(app, 'POST', '/deposits', 'own', { id: 'dep-1', agreementId: 'ag-1', amountCents: 50000 }).status, 201);
});

test('every country profile builds a complete environment', () => {
  for (const code of ['BR', 'US', 'PT', 'ES', 'MX', 'GB']) {
    const env = buildEnvironment(code);
    assert.ok(env.config.currency && env.jurisdiction && env.policy.length > 0);
    assert.deepEqual([...env.masterDataStructure], [...MASTER_DATA_STRUCTURE]);
  }
});
