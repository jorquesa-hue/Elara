// Tranche 77 — Phase 6A: renters-insurance compliance. Residents on a lease
// must carry liability coverage; the operator tracks each policy against its
// agreement, and the coverage status (compliant / expiring / lapsed / none) is
// a pure function of the policies + today. RBAC-only, durable. 13 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';
import { projectWorld } from '../src/persistence/project.ts';
import { coverageStatus, policyInForce, type InsurancePolicy } from '../src/insurance.ts';

const NOW = '2026-07-13T00:00:00Z';
const own: AuthContext = { actor: 'own', tenantId: 'mf', role: 'owner' };
const bot: AuthContext = { actor: 'bot', tenantId: 'mf', role: 'agent' };
const ro: AuthContext = { actor: 'r', tenantId: 'mf', role: 'read_only' };
const resident: AuthContext = { actor: 'bea', tenantId: 'mf', role: 'read_only', partyId: 'pty-bea' };

const D = (app: App, method: string, path: string, body?: Record<string, unknown>, token = 'own') =>
  app.dispatch({ method, path, bearer: `Bearer ${token}`, body: body ?? {} });

function mkApp() {
  const app = new App({ authenticator: new StaticTokenAuthenticator({ own, bot, r: ro, bea: resident }), units: [], now: () => NOW });
  D(app, 'PUT', '/config', { displayName: 'Greyline', country: 'US' });
  D(app, 'POST', '/units', { id: 'u-1', code: 'A-1', label: 'Apt 101' });
  D(app, 'POST', '/agreements', { id: 'ag-1', guestId: 'Bea Lima', unitId: 'u-1', kind: 'lease', start: '2026-01-01', end: '2027-01-01', rateCents: 300000 });
  D(app, 'POST', '/agreements/ag-1/activate', {});
  D(app, 'POST', '/parties', { id: 'pty-bea', kind: 'person', displayName: 'Bea Lima', email: 'bea@x.com' });
  D(app, 'POST', '/agreements/ag-1/parties', { partyId: 'pty-bea', role: 'resident' });
  return app;
}
function create(app: App, over: Record<string, unknown> = {}, token = 'own') {
  return D(app, 'POST', '/insurance-policies', {
    id: 'ins-1', agreementId: 'ag-1', carrier: 'Lemonade', policyNumber: 'POL-123',
    liabilityCents: 10000000, effectiveAt: '2026-06-01', expiresAt: '2027-06-01', ...over,
  }, token);
}

// --- pure helpers ------------------------------------------------------------

test('policyInForce and coverageStatus classify coverage as of a date', () => {
  const base = { id: 'x', tenantId: 'mf', agreementId: 'ag', carrier: 'c', policyNumber: 'n', liabilityCents: 0, createdAt: NOW } as const;
  const compliant: InsurancePolicy = { ...base, status: 'active', effectiveAt: '2026-06-01', expiresAt: '2027-06-01' };
  const expiring: InsurancePolicy = { ...base, status: 'active', effectiveAt: '2026-06-01', expiresAt: '2026-08-01' };
  const lapsed: InsurancePolicy = { ...base, status: 'active', effectiveAt: '2026-01-01', expiresAt: '2026-07-01' };
  assert.equal(policyInForce(compliant, NOW), true);
  assert.equal(policyInForce(lapsed, NOW), false); // expired before today
  assert.equal(coverageStatus([compliant], NOW), 'compliant');
  assert.equal(coverageStatus([expiring], NOW), 'expiring'); // expires within 30 days
  assert.equal(coverageStatus([lapsed], NOW), 'lapsed');
  assert.equal(coverageStatus([], NOW), 'none');
});

// --- endpoints ---------------------------------------------------------------

test('create a policy; the list folds resident/unit labels + coverage', () => {
  const app = mkApp();
  assert.equal(create(app).status, 201);
  const rows = (D(app, 'GET', '/insurance-policies').body as { policies: Array<{ id: string; carrier: string; residentName: string; unitLabel: string; coverage: string }> }).policies;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.carrier, 'Lemonade');
  assert.equal(rows[0]!.residentName, 'Bea Lima');
  assert.equal(rows[0]!.unitLabel, 'Apt 101');
  assert.equal(rows[0]!.coverage, 'compliant');
});

test('unknown agreement 404s; unknown party 404s', () => {
  const app = mkApp();
  assert.equal(create(app, { agreementId: 'ghost' }).status, 404);
  assert.equal(create(app, { id: 'ins-p', partyId: 'nobody' }).status, 404);
});

test('bad dates and negative liability are rejected', () => {
  const app = mkApp();
  assert.equal(create(app, { id: 'ins-bad', effectiveAt: '2027-01-01', expiresAt: '2026-01-01' }).status, 409);
  assert.equal(create(app, { id: 'ins-neg', liabilityCents: -5 }).status, 409);
});

test('GET /agreements/:id/insurance returns coverage + policies', () => {
  const app = mkApp(); create(app);
  const body = D(app, 'GET', '/agreements/ag-1/insurance').body as { coverage: string; policies: unknown[] };
  assert.equal(body.coverage, 'compliant');
  assert.equal(body.policies.length, 1);
});

test('cancelling a policy flips the coverage to lapsed', () => {
  const app = mkApp(); create(app);
  assert.equal(D(app, 'POST', '/insurance-policies/ins-1/cancel', {}).status, 200);
  assert.equal((D(app, 'GET', '/agreements/ag-1/insurance').body as { coverage: string }).coverage, 'lapsed');
});

test('verifying a policy stamps verifiedAt', () => {
  const app = mkApp(); create(app);
  const r = D(app, 'POST', '/insurance-policies/ins-1/verify', {});
  assert.equal(r.status, 200);
  assert.equal((r.body as { verifiedAt: string }).verifiedAt, NOW);
});

test('insurance.manage gates writes; read_only reads; agent (OPS) manages', () => {
  const app = mkApp(); create(app);
  assert.equal(D(app, 'GET', '/insurance-policies', undefined, 'r').status, 200);
  assert.equal(create(app, { id: 'ins-ro' }, 'r').status, 403);
  assert.equal(create(app, { id: 'ins-bot' }, 'bot').status, 201);
});

test('policies are tenant-scoped', () => {
  const app = mkApp(); create(app);
  const o2: AuthContext = { actor: 'o2', tenantId: 'other', role: 'owner' };
  const app2 = new App({ authenticator: new StaticTokenAuthenticator({ o2 }), now: () => NOW });
  app2.dispatch({ method: 'PUT', path: '/config', bearer: 'Bearer o2', body: { displayName: 'O', country: 'US' } });
  assert.equal((app2.dispatch({ method: 'GET', path: '/insurance-policies', bearer: 'Bearer o2', body: {} }).body as { policies: unknown[] }).policies.length, 0);
  assert.equal(app2.dispatch({ method: 'POST', path: '/insurance-policies/ins-1/cancel', bearer: 'Bearer o2', body: {} }).status, 404);
});

test('the compliance report scores active leases and computes the rate', () => {
  const app = mkApp(); create(app); // ag-1 is compliant
  // A second active lease with NO policy.
  D(app, 'POST', '/units', { id: 'u-2', code: 'A-2', label: 'Apt 102' });
  D(app, 'POST', '/agreements', { id: 'ag-2', guestId: 'Cid Silva', unitId: 'u-2', kind: 'monthly', start: '2026-01-01', end: '2027-01-01', rateCents: 250000 });
  D(app, 'POST', '/agreements/ag-2/activate', {});
  const rep = D(app, 'GET', '/reports/insurance_compliance').body as { report: { rows: Array<{ status: string }>; kpis: Array<{ label: string; value: number }> } };
  assert.equal(rep.report.rows.length, 2);
  const kpi = (l: string) => rep.report.kpis.find((k) => k.label === l)!.value;
  assert.equal(kpi('Active leases'), 2);
  assert.equal(kpi('Insured'), 1);
  assert.equal(kpi('Compliance rate'), 50);
  assert.equal(kpi('Uninsured / lapsed'), 1);
});

test('an uninsured active lease fires a compliance insight', () => {
  const app = mkApp(); // ag-1 active, no policy filed
  const insights = (D(app, 'GET', '/reports/insights').body as { insights: Array<{ title: string; severity: string }> }).insights;
  assert.ok(insights.some((i) => /no active renters insurance/i.test(i.title) && i.severity === 'warning'));
});

test('a resident sees only their own coverage; an operator token is 403', () => {
  const app = mkApp(); create(app);
  const body = D(app, 'GET', '/resident/insurance', undefined, 'bea').body as { leases: Array<{ agreementId: string; coverage: string; policies: unknown[] }> };
  assert.equal(body.leases.length, 1);
  assert.equal(body.leases[0]!.agreementId, 'ag-1');
  assert.equal(body.leases[0]!.coverage, 'compliant');
  assert.equal(D(app, 'GET', '/resident/insurance', undefined, 'own').status, 403); // operator, no partyId
});

test('a policy projects to SQL and survives snapshot → rehydrate', () => {
  const app = mkApp(); create(app); D(app, 'POST', '/insurance-policies/ins-1/verify', {});
  const ins = projectWorld(app.snapshotWorld('mf')).find((x) => x.text.startsWith('insert into insurance_policy '));
  assert.ok(ins);
  const b = new App({ authenticator: new StaticTokenAuthenticator({ own }), now: () => NOW });
  b.rehydrate(app.snapshotWorld('mf'));
  const p = (b.snapshotWorld('mf').insurancePolicies ?? []).find((x) => x.id === 'ins-1')!;
  assert.equal(p.carrier, 'Lemonade');
  assert.equal(p.liabilityCents, 10000000);
  assert.equal(p.verifiedAt, NOW);
});
