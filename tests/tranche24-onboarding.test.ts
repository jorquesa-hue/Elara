// Tranche 24 — CSV + AI onboarding importer (#15). A pure pipeline: parse a
// CSV (quotes, escaped quotes, CRLF), map arbitrary source headers to canonical
// fields (the "AI mapping" seam — heuristic fallback), then plan the import with
// per-row validation. Preview is a dry-run; commit applies ok rows to master
// data through the authenticated surface. 13 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseCsv, suggestMapping, planImport, OnboardingError } from '../src/onboarding.ts';
import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';

const T = '2026-07-01T00:00:00Z';
const bearer = (t: string) => `Bearer ${t}`;
const D = (app: App, method: string, path: string, token: string, body?: Record<string, unknown>) =>
  app.dispatch({ method, path, bearer: bearer(token), body });

// ---- pure parser ---------------------------------------------------------

test('parseCsv splits headers from rows', () => {
  const { headers, rows } = parseCsv('code,label\nRIO-101,Studio\nRIO-102,Suite\n');
  assert.deepEqual(headers, ['code', 'label']);
  assert.deepEqual(rows, [['RIO-101', 'Studio'], ['RIO-102', 'Suite']]);
});

test('parseCsv handles quoted fields, commas and escaped quotes', () => {
  const { rows } = parseCsv('code,label\nA,"Corner, top floor"\nB,"He said ""hi"""\n');
  assert.deepEqual(rows[0], ['A', 'Corner, top floor']);
  assert.deepEqual(rows[1], ['B', 'He said "hi"']);
});

test('parseCsv tolerates CRLF and a missing trailing newline', () => {
  const { headers, rows } = parseCsv('code,label\r\nA,One\r\nB,Two');
  assert.deepEqual(headers, ['code', 'label']);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1], ['B', 'Two']);
});

test('parseCsv on empty input yields no headers', () => {
  assert.deepEqual(parseCsv(''), { headers: [], rows: [] });
});

test('suggestMapping matches header aliases in any order', () => {
  const m = suggestMapping('guests', ['E-mail', 'Full Name', 'CPF']);
  assert.equal(m['fullName'], 1);
  assert.equal(m['email'], 0);
  assert.equal(m['code'], 2); // CPF → code alias
});

test('planImport validates required fields and flags in-file duplicates', () => {
  const headers = ['code', 'label'];
  const rows = [['RIO-101', 'Studio'], ['', 'No code'], ['RIO-101', 'Dup']];
  const plan = planImport('units', headers, rows, suggestMapping('units', headers));
  assert.equal(plan.okCount, 1);
  assert.equal(plan.errorCount, 2);
  assert.equal(plan.rows[1]!.status, 'error');
  assert.ok(plan.rows[1]!.errors[0]!.includes('missing code'));
  assert.ok(plan.rows[2]!.errors[0]!.includes('duplicate'));
});

test('planImport defaults a unit label to its code', () => {
  const plan = planImport('units', ['code'], [['RIO-9']], { code: 0 });
  assert.equal(plan.rows[0]!.record!['label'], 'RIO-9');
});

test('planImport throws when a required field is unmapped', () => {
  assert.throws(() => planImport('guests', ['nickname'], [['x']], {}), OnboardingError);
});

// ---- through the Public API ----------------------------------------------

function makeApp() {
  const owner: AuthContext = { actor: 'ana', tenantId: 't1', role: 'owner' };
  const desk: AuthContext = { actor: 'desk', tenantId: 't1', role: 'front_desk' };
  const auth = new StaticTokenAuthenticator({ own: owner, desk });
  return new App({ authenticator: auth, now: () => T });
}
const UNITS_CSV = 'Unit Code,Unit Name\nRIO-101,Ocean Studio\nRIO-102,Garden Suite\n,Missing\n';

test('API: preview is a dry-run — it plans but writes nothing', () => {
  const app = makeApp();
  const r = D(app, 'POST', '/onboarding/preview', 'own', { target: 'units', csv: UNITS_CSV });
  assert.equal(r.status, 200);
  const body = r.body as { mapping: Record<string, number>; plan: { okCount: number; errorCount: number } };
  assert.equal(body.mapping['code'], 0); // "Unit Code" → code
  assert.equal(body.mapping['label'], 1);
  assert.equal(body.plan.okCount, 2);
  assert.equal(body.plan.errorCount, 1);
  // nothing was created
  assert.equal((D(app, 'GET', '/master-data', 'own').body as { units: unknown[] }).units.length, 0);
});

test('API: commit applies the ok rows to master data', () => {
  const app = makeApp();
  const r = D(app, 'POST', '/onboarding/commit', 'own', { target: 'units', csv: UNITS_CSV });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body, { target: 'units', created: 2, skipped: 0, errorRows: 1, total: 3 });
  const units = (D(app, 'GET', '/master-data', 'own').body as { units: Array<{ code: string; label: string }> }).units;
  assert.equal(units.length, 2);
  assert.ok(units.find((u) => u.code === 'RIO-101' && u.label === 'Ocean Studio'));
});

test('API: re-committing the same file skips already-imported codes (idempotent)', () => {
  const app = makeApp();
  D(app, 'POST', '/onboarding/commit', 'own', { target: 'units', csv: UNITS_CSV });
  const again = D(app, 'POST', '/onboarding/commit', 'own', { target: 'units', csv: UNITS_CSV });
  assert.deepEqual(again.body, { target: 'units', created: 0, skipped: 2, errorRows: 1, total: 3 });
});

test('API: a caller-supplied mapping overrides the heuristic', () => {
  const app = makeApp();
  // headers the heuristic would map differently; force code←col1, fullName←col0
  const csv = 'Name,Ref\nAna Souza,G-1\nBia Lima,G-2\n';
  const r = D(app, 'POST', '/onboarding/commit', 'own', { target: 'guests', csv, mapping: { code: 1, fullName: 0 } });
  assert.equal((r.body as { created: number }).created, 2);
  const guests = (D(app, 'GET', '/master-data', 'own').body as { guests: Array<{ code: string; fullName: string }> }).guests;
  assert.ok(guests.find((g) => g.code === 'G-1' && g.fullName === 'Ana Souza'));
});

test('API: RBAC — front desk cannot onboard (needs masterdata.manage)', () => {
  const app = makeApp();
  assert.equal(D(app, 'POST', '/onboarding/preview', 'desk', { target: 'units', csv: UNITS_CSV }).status, 403);
});
