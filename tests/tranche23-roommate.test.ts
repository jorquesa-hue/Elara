// Tranche 23 — student roommate matching (#9). A pure, deterministic
// compatibility engine scores how well two prospects would share a room (0..100)
// with an explainable per-dimension breakdown, honours hard deal-breakers
// (smoke-free / pet-free), and greedily suggests groupings to fill a room of N
// beds. Placement itself reuses the agreement + transfer (#23) paths. 12 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compatibility, RoommateMatcher, RoommateError, type RoommatePreferences } from '../src/roommate.ts';
import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';

const T = '2026-07-01T00:00:00Z';
const bearer = (t: string) => `Bearer ${t}`;
const D = (app: App, method: string, path: string, token: string, body?: Record<string, unknown>) =>
  app.dispatch({ method, path, bearer: bearer(token), body });

// ---- pure engine ---------------------------------------------------------

test('two identical profiles are a perfect match', () => {
  const p: RoommatePreferences = { cleanliness: 4, social: 3, chronotype: 'early', smoker: false };
  const c = compatibility(p, p);
  assert.equal(c.score, 100);
  assert.equal(c.compatible, true);
  assert.equal(c.factors.length, 0);
});

test('lifestyle distance lowers the score with an explanation', () => {
  const a: RoommatePreferences = { cleanliness: 5, social: 1 };
  const b: RoommatePreferences = { cleanliness: 2, social: 4 };
  const c = compatibility(a, b);
  // cleanliness |5-2|*8 = 24, social |1-4|*6 = 18 → 100-42 = 58
  assert.equal(c.score, 58);
  assert.ok(c.factors.some((f) => f.dimension === 'cleanliness' && f.delta === -24));
  assert.ok(c.factors.some((f) => f.dimension === 'social' && f.delta === -18));
});

test('an early/late chronotype clash is penalised; flexible never clashes', () => {
  assert.equal(compatibility({ chronotype: 'early' }, { chronotype: 'late' }).score, 85);
  assert.equal(compatibility({ chronotype: 'early' }, { chronotype: 'flexible' }).score, 100);
});

test('a smoke-free deal-breaker forces incompatibility (score 0)', () => {
  const nonSmoker: RoommatePreferences = { smokeFreeOnly: true };
  const smoker: RoommatePreferences = { smoker: true };
  const c = compatibility(nonSmoker, smoker);
  assert.equal(c.compatible, false);
  assert.equal(c.score, 0);
  assert.deepEqual(c.dealBreakers, ['smoking']);
  // symmetric
  assert.equal(compatibility(smoker, nonSmoker).compatible, false);
});

test('a pet-free deal-breaker forces incompatibility', () => {
  const c = compatibility({ petFreeOnly: true }, { hasPet: true });
  assert.equal(c.compatible, false);
  assert.deepEqual(c.dealBreakers, ['pets']);
});

test('matcher validates preference ranges', () => {
  const m = new RoommateMatcher();
  assert.throws(() => m.upsertProspect({ id: 'p1', tenantId: 't1', name: 'A', preferences: { cleanliness: 9 } }), RoommateError);
  assert.throws(() => m.upsertProspect({ id: 'p2', tenantId: 't1', name: 'B', preferences: { social: 0 } }), RoommateError);
});

test('matchesFor ranks other prospects by score, deterministically', () => {
  const m = new RoommateMatcher();
  m.upsertProspect({ id: 'ava', tenantId: 't1', name: 'Ava', preferences: { cleanliness: 5, social: 2 } });
  m.upsertProspect({ id: 'bea', tenantId: 't1', name: 'Bea', preferences: { cleanliness: 5, social: 2 } }); // identical → 100
  m.upsertProspect({ id: 'cid', tenantId: 't1', name: 'Cid', preferences: { cleanliness: 1, social: 5 } }); // far
  m.upsertProspect({ id: 'dan', tenantId: 't2', name: 'Dan', preferences: { cleanliness: 5, social: 2 } }); // other tenant
  const ranked = m.matchesFor('t1', 'ava');
  assert.equal(ranked.length, 2); // excludes self and the other tenant
  assert.equal(ranked[0]!.prospectId, 'bea');
  assert.equal(ranked[0]!.score, 100);
  assert.equal(ranked[1]!.prospectId, 'cid');
  assert.ok(ranked[0]!.score > ranked[1]!.score);
});

test('suggestGrouping fills rooms and never groups a deal-breaker pair', () => {
  const m = new RoommateMatcher();
  m.upsertProspect({ id: 'a', tenantId: 't1', name: 'A', preferences: { cleanliness: 5, smokeFreeOnly: true } });
  m.upsertProspect({ id: 'b', tenantId: 't1', name: 'B', preferences: { cleanliness: 5 } });
  m.upsertProspect({ id: 'c', tenantId: 't1', name: 'C', preferences: { cleanliness: 5, smoker: true } });
  m.upsertProspect({ id: 'd', tenantId: 't1', name: 'D', preferences: { cleanliness: 5 } });
  const groups = m.suggestGrouping('t1', 2);
  // A won't share with C (smoker); A seeds first and pulls B (best compatible).
  const aGroup = groups.find((g) => g.members.includes('a'))!;
  assert.ok(!aGroup.members.includes('c'));
  assert.equal(aGroup.members.length, 2);
  // every prospect is placed exactly once
  const all = groups.flatMap((g) => g.members).sort();
  assert.deepEqual(all, ['a', 'b', 'c', 'd']);
});

test('suggestGrouping rejects a capacity below 2', () => {
  const m = new RoommateMatcher();
  assert.throws(() => m.suggestGrouping('t1', 1), RoommateError);
});

// ---- through the Public API ----------------------------------------------

function makeApp() {
  const owner: AuthContext = { actor: 'ana', tenantId: 't1', role: 'owner' };
  const desk: AuthContext = { actor: 'desk', tenantId: 't1', role: 'front_desk' };
  const reader: AuthContext = { actor: 'aud', tenantId: 't1', role: 'read_only' };
  const auth = new StaticTokenAuthenticator({ own: owner, desk, ro: reader });
  return new App({ authenticator: auth, now: () => T });
}

test('API: register prospects, then rank matches for one', () => {
  const app = makeApp();
  assert.equal(D(app, 'POST', '/prospects', 'own', { id: 'ava', name: 'Ava', preferences: { cleanliness: 4, social: 3, chronotype: 'early' } }).status, 201);
  D(app, 'POST', '/prospects', 'own', { id: 'bea', name: 'Bea', preferences: { cleanliness: 4, social: 3, chronotype: 'early' } });
  D(app, 'POST', '/prospects', 'own', { id: 'cid', name: 'Cid', preferences: { cleanliness: 1, social: 5, smoker: true } });
  const r = D(app, 'GET', '/prospects/ava/matches', 'own');
  assert.equal(r.status, 200);
  const matches = (r.body as { matches: Array<{ prospectId: string; score: number }> }).matches;
  assert.equal(matches[0]!.prospectId, 'bea');
  assert.equal(matches[0]!.score, 100);
  assert.equal(D(app, 'GET', '/prospects/nope/matches', 'own').status, 404);
});

test('API: grouping endpoint suggests roommate groups of a given capacity', () => {
  const app = makeApp();
  for (const id of ['a', 'b', 'c', 'd']) D(app, 'POST', '/prospects', 'own', { id, name: id.toUpperCase(), preferences: { cleanliness: 4 } });
  const r = D(app, 'POST', '/roommate/grouping', 'own', { capacity: 2 });
  assert.equal(r.status, 200);
  const groups = (r.body as { groups: Array<{ members: string[] }> }).groups;
  assert.equal(groups.length, 2);
  assert.equal(groups[0]!.members.length, 2);
});

test('API: RBAC — front desk manages (OPS); read_only reads but cannot register', () => {
  const app = makeApp();
  assert.equal(D(app, 'POST', '/prospects', 'desk', { id: 'x', name: 'X', preferences: {} }).status, 201); // roommate.manage in OPS
  assert.equal(D(app, 'GET', '/prospects', 'ro').status, 200);
  assert.equal(D(app, 'POST', '/prospects', 'ro', { id: 'y', name: 'Y', preferences: {} }).status, 403);
});
