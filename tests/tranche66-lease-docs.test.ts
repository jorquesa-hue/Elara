// Tranche 66 — Phase 2B: lease-document generation feeding e-sign. Draft a
// jurisdiction-aware lease from an agreement's deal terms, preview it, then open
// an e-sign envelope whose roster is drawn from the same party links. The
// document is deterministic (no storage of its own); signing does NOT execute
// the lease. 11 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';
import { buildLeaseDocument, renderLeaseText, type LeaseTerms } from '../src/lease-doc.ts';

const NOW = '2026-07-13T00:00:00Z';
const own: AuthContext = { actor: 'own', tenantId: 'mf', role: 'owner' };
const ro: AuthContext = { actor: 'r', tenantId: 'mf', role: 'read_only' };

function mkApp(country = 'BR') {
  const app = new App({ authenticator: new StaticTokenAuthenticator({ own, ro }), units: [], now: () => NOW });
  D(app, 'PUT', '/config', { displayName: 'Greyline Living', country });
  D(app, 'POST', '/units', { id: 'u-1', code: 'A-1', label: 'Apt 101' });
  D(app, 'POST', '/agreements', { id: 'ag-1', guestId: 'g-1', unitId: 'u-1', kind: 'lease', start: '2026-08-01', end: '2027-08-01', rateCents: 300000 });
  D(app, 'POST', '/agreements/ag-1/activate', {});
  return app;
}
const D = (app: App, method: string, path: string, body?: Record<string, unknown>, token = 'own') =>
  app.dispatch({ method, path, bearer: `Bearer ${token}`, body: body ?? {} });

function baseTerms(over: Partial<LeaseTerms> = {}): LeaseTerms {
  return { agreementId: 'ag-1', landlordName: 'Greyline Living', residentName: 'Bea Lima', unitLabel: 'Apt 101', kind: 'lease', rateCents: 300000, currency: 'BRL', start: '2026-08-01', end: '2027-08-01', jurisdiction: 'BR', generatedAt: NOW, ...over };
}

// --- pure generator -------------------------------------------------------
test('the generator drafts titled clauses with parties and the rent figure', () => {
  const doc = buildLeaseDocument(baseTerms());
  assert.match(doc.title, /Apt 101/);
  assert.equal(doc.parties[0]!.role, 'landlord');
  assert.equal(doc.parties[1]!.name, 'Bea Lima');
  const rent = doc.clauses.find((c) => /Rent/.test(c.heading))!;
  assert.match(rent.body, /BRL 3,000\.00 per month/);
});

test('a BR lease cites the Lei do Inquilinato; a US lease cites Fair Housing', () => {
  assert.ok(buildLeaseDocument(baseTerms({ jurisdiction: 'BR' })).clauses.some((c) => /Lei do Inquilinato/.test(c.body)));
  assert.ok(buildLeaseDocument(baseTerms({ jurisdiction: 'US', currency: 'USD' })).clauses.some((c) => /Fair Housing/.test(c.body)));
});

test('a deposit adds a Security Deposit clause; a guarantor is named', () => {
  const doc = buildLeaseDocument(baseTerms({ depositCents: 300000, guarantorName: 'Carlos Pai' }));
  assert.ok(doc.clauses.some((c) => /Security Deposit/.test(c.heading)));
  assert.ok(doc.parties.some((p) => p.role === 'guarantor' && p.name === 'Carlos Pai'));
});

test('rendering flattens to signable text with a signature line per party', () => {
  const txt = renderLeaseText(buildLeaseDocument(baseTerms({ guarantorName: 'Carlos Pai' })));
  assert.match(txt, /Residential Lease/);
  assert.match(txt, /resident: Bea Lima/);
  assert.match(txt, /guarantor: Carlos Pai/);
});

test('the generator is deterministic', () => {
  assert.deepEqual(buildLeaseDocument(baseTerms()), buildLeaseDocument(baseTerms()));
});

test('a missing resident is rejected', () => {
  assert.throws(() => buildLeaseDocument(baseTerms({ residentName: '' })));
});

// --- App endpoints --------------------------------------------------------
test('GET /agreements/:id/lease-document drafts from the agreement terms', () => {
  const app = mkApp('BR');
  const r = D(app, 'GET', '/agreements/ag-1/lease-document');
  assert.equal(r.status, 200);
  const doc = (r.body as { document: { title: string; clauses: Array<{ body: string }> } }).document;
  assert.match(doc.title, /Apt 101/);
  assert.ok(doc.clauses.some((c) => /BRL 3,000\.00 per month/.test(c.body)));
  assert.match((r.body as { text: string }).text, /Residential Lease/);
});

test('the lease-document resident name comes from the linked resident party', () => {
  const app = mkApp('BR');
  D(app, 'POST', '/parties', { id: 'pty-1', kind: 'person', displayName: 'Bea Lima', email: 'bea@x.com' });
  D(app, 'POST', '/agreements/ag-1/parties', { partyId: 'pty-1', role: 'resident' });
  const doc = (D(app, 'GET', '/agreements/ag-1/lease-document').body as { document: { parties: Array<{ role: string; name: string }> } }).document;
  assert.ok(doc.parties.some((p) => p.role === 'resident' && p.name === 'Bea Lima'));
});

test('POST /agreements/:id/lease-envelope rosters signers from party emails and drafts an envelope', () => {
  const app = mkApp('BR');
  D(app, 'POST', '/parties', { id: 'pty-1', kind: 'person', displayName: 'Bea Lima', email: 'bea@x.com' });
  D(app, 'POST', '/parties', { id: 'pty-2', kind: 'person', displayName: 'Carlos Pai', email: 'carlos@x.com' });
  D(app, 'POST', '/agreements/ag-1/parties', { partyId: 'pty-1', role: 'resident' });
  D(app, 'POST', '/agreements/ag-1/parties', { partyId: 'pty-2', role: 'guarantor' });
  const r = D(app, 'POST', '/agreements/ag-1/lease-envelope', { provider: 'docusign' });
  assert.equal(r.status, 201);
  const env = (r.body as { envelope: { status: string; documentName: string; signers: Array<{ email: string; role: string }> } }).envelope;
  assert.equal(env.status, 'draft');
  assert.match(env.documentName, /Apt 101/);
  assert.equal(env.signers.length, 2);
  assert.ok(env.signers.some((s) => s.email === 'bea@x.com' && s.role === 'resident'));
  assert.ok(env.signers.some((s) => s.email === 'carlos@x.com' && s.role === 'guarantor'));
  // The drafted envelope is listed and can be sent through the normal e-sign path.
  assert.equal(D(app, 'POST', '/signature-envelopes/env-ag-1/send', {}).status, 200);
});

test('lease-envelope 400s when no linked party has an email to sign', () => {
  const app = mkApp('BR');
  assert.equal(D(app, 'POST', '/agreements/ag-1/lease-envelope', {}).status, 400);
});

test('read_only may preview a lease but not open an envelope', () => {
  const app = mkApp('BR');
  assert.equal(D(app, 'GET', '/agreements/ag-1/lease-document', undefined, 'ro').status, 200);
  assert.equal(D(app, 'POST', '/agreements/ag-1/lease-envelope', {}, 'ro').status, 403);
});
