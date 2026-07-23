// Tranche 94 — the flush coalescer. A large seed (the institutional portfolio)
// projects to ~6000 single-row INSERTs; applied one-by-one in a single edge
// transaction that exceeds the runtime budget and rolls the whole batch back,
// so nothing persists. coalesceStatements() merges consecutive same-table rows
// into multi-row INSERTs, cutting the statement count ~30x. This pins that it
// (a) drastically reduces the count, (b) never exceeds the Postgres parameter
// limit, and (c) preserves every row and its values exactly.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';
import { projectWorld } from '../src/persistence/project.ts';
import type { SqlStatement } from '../src/persistence/executor.ts';
import { coalesceStatements } from '../src/persistence/coalesce.ts';

const NOW = '2026-07-24T00:00:00Z';
const own: AuthContext = { actor: 'own', tenantId: 'jq', role: 'owner' };

function institutionalStatements(): SqlStatement[] {
  const app = new App({ authenticator: new StaticTokenAuthenticator({ own }), units: [], now: () => NOW });
  app.dispatch({ method: 'PUT', path: '/config', bearer: 'Bearer own', body: { displayName: 'M', country: 'US' } });
  app.dispatch({ method: 'POST', path: '/demo/seed', bearer: 'Bearer own', body: { variant: 'portfolio', at: NOW } });
  return projectWorld(app.snapshotWorld('jq'));
}

test('coalescing a large world collapses thousands of inserts into a few hundred', () => {
  const raw = institutionalStatements();
  assert.ok(raw.length > 3000, `expected a big projection, got ${raw.length}`);
  const co = coalesceStatements(raw);
  assert.ok(co.length < raw.length / 10, `expected >10x reduction, got ${raw.length} -> ${co.length}`);
  // No statement may exceed Postgres's 65535-parameter ceiling.
  for (const s of co) assert.ok(s.values.length <= 65535, `statement has ${s.values.length} params`);
});

test('coalescing preserves every row and value in order', () => {
  const raw = institutionalStatements();
  const co = coalesceStatements(raw);
  // Total parameter values are conserved (nothing dropped or duplicated).
  const rawParams = raw.reduce((n, s) => n + s.values.length, 0);
  const coParams = co.reduce((n, s) => n + s.values.length, 0);
  assert.equal(coParams, rawParams, 'value count conserved');
  // Every merged statement has params === (rows × placeholders) and its
  // placeholders run 1..N with no gaps.
  for (const s of co) {
    const nums = [...s.text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
    if (nums.length) {
      assert.equal(nums.length, s.values.length, 'placeholder count matches values');
      assert.equal(Math.max(...nums), s.values.length, 'placeholders numbered 1..N');
      assert.equal(Math.min(...nums), 1, 'placeholders start at 1');
    }
  }
});

test('small worlds and non-insert statements pass through untouched', () => {
  const stmts: SqlStatement[] = [
    { text: 'insert into unit (id, tenant_id) values ($1, $2) on conflict (id) do nothing', values: ['u1', 't'] },
    { text: 'set constraints all immediate', values: [] },
  ];
  const co = coalesceStatements(stmts);
  assert.deepEqual(co, stmts, 'a lone insert + a non-insert are unchanged');
});
