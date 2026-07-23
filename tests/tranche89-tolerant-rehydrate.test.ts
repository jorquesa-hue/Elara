// Tranche 89 — schema-drift-tolerant cold start. The app can deploy AHEAD of a
// migration being applied to the live DB (exactly what happened when
// property_budget shipped while the DB connection was unavailable). loadWorld
// must degrade PER TABLE — the missing relation loads empty, everything else
// rehydrates — instead of failing the whole cold start. The `tenant` table stays
// strict: if THAT is missing, the server is pointed at the wrong database.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Repositories, type QueryExecutor, type Row } from '../src/persistence/repository.ts';
import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';

const own: AuthContext = { actor: 'a', tenantId: 'jq', role: 'owner' };

/** Executor simulating a live DB that predates the property_budget migration:
 *  tenant + core rows exist, property_budget throws Postgres 42P01. */
function schemaBehindExecutor(alsoMissing: string[] = []): QueryExecutor {
  return {
    async query(stmt): Promise<Row[]> {
      const t = stmt.text;
      for (const rel of ['property_budget', ...alsoMissing]) {
        if (t.includes(`from ${rel} `) || t.includes(`from ${rel}\n`)) {
          const err = new Error(`relation "${rel}" does not exist`) as Error & { code: string };
          err.code = '42P01';
          throw err;
        }
      }
      if (t.includes('from tenant where id = $1')) {
        return [{ id: 'jq', name: 'jq', display_name: 'Ilhabela Stays', locale: 'pt-BR', currency: 'BRL', timezone: 'America/Sao_Paulo', country: 'BR', jurisdiction: 'BR' }];
      }
      if (t.includes('from unit where tenant_id')) {
        return [{ id: 'unit-1', tenant_id: 'jq', label: 'Apt 101', code: 'A101', active: true }];
      }
      return []; // every other table exists but is empty
    },
  };
}

test('a missing feature relation loads empty instead of failing the whole cold start', async () => {
  const repo = new Repositories(schemaBehindExecutor(), 'jq');
  const world = await repo.loadWorld();
  assert.equal(world.tenants?.length, 1, 'tenant config loaded');
  assert.equal(world.units?.length, 1, 'units loaded');
  assert.deepEqual(world.propertyBudgets ?? [], [], 'the missing table degrades to empty');
  // And the world still rehydrates into a serving App.
  const app = new App({ authenticator: new StaticTokenAuthenticator({ own }), units: [], now: () => '2026-07-24T00:00:00Z' });
  app.rehydrate(world);
  const r = app.dispatch({ method: 'GET', path: '/config', bearer: 'Bearer own', body: {} });
  assert.equal(r.status, 200);
  assert.equal((r.body as { config: { displayName: string } }).config.displayName, 'Ilhabela Stays');
});

test('several missing feature relations all degrade; unrelated errors still throw', async () => {
  const repo = new Repositories(schemaBehindExecutor(['waitlist_entry', 'contribution']), 'jq');
  const world = await repo.loadWorld();
  assert.deepEqual(world.waitlist ?? [], []);
  assert.deepEqual(world.contributions ?? [], []);
  // A non-42P01 failure is NOT swallowed.
  const broken: QueryExecutor = {
    async query(stmt): Promise<Row[]> {
      if (stmt.text.includes('from tenant where id = $1')) return [{ id: 'jq', name: 'jq' }];
      if (stmt.text.includes('from unit where')) throw new Error('connection reset');
      return [];
    },
  };
  await assert.rejects(() => new Repositories(broken, 'jq').loadWorld(), /connection reset/);
});

test('a missing tenant table still fails loudly (wrong database, not schema drift)', async () => {
  const noTenant: QueryExecutor = {
    async query(stmt): Promise<Row[]> {
      if (stmt.text.includes('from tenant where id = $1')) {
        const err = new Error('relation "tenant" does not exist') as Error & { code: string };
        err.code = '42P01';
        throw err;
      }
      return [];
    },
  };
  await assert.rejects(() => new Repositories(noTenant, 'jq').loadWorld(), /relation "tenant" does not exist/);
});
