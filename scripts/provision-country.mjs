// Provision a country environment. Prints the COMPLETE setup for one country:
// the identical migration list every country runs, the config seeded from the
// country profile, and the effective (jurisdiction-scoped) policy. Running this
// for BR vs US shows the same schema + kernel with a different environment — the
// master-data STRUCTURE never forks.
//
//   npx tsx scripts/provision-country.mjs BR
//   npx tsx scripts/provision-country.mjs US
import { readdirSync } from 'node:fs';
import { buildEnvironment, MASTER_DATA_STRUCTURE } from '../src/environment.ts';
import { COUNTRY_PROFILES } from '../src/country.ts';

const code = (process.argv[2] ?? 'BR').toUpperCase();
if (!COUNTRY_PROFILES.some((c) => c.code === code)) {
  console.error(`unknown country: ${code}. Known: ${COUNTRY_PROFILES.map((c) => c.code).join(', ')}`);
  process.exit(1);
}

const env = buildEnvironment(code);
const migrations = readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter((f) => f.endsWith('.sql')).sort();

console.log(`\n=== Provision country environment: ${env.country} (jurisdiction ${env.jurisdiction}) ===\n`);

console.log('1) Schema — the IDENTICAL migrations every country runs (no per-country fork):');
for (const m of migrations) console.log(`     supabase/migrations/${m}`);

console.log('\n2) Master-data STRUCTURE — the same aggregates for every country:');
console.log(`     ${MASTER_DATA_STRUCTURE.join(', ')}`);

console.log('\n3) Config — seeded from this country profile:');
console.log(`     currency=${env.config.currency}  locale=${env.config.locale}  timezone=${env.config.timezone}`);
console.log(`     tax identity: ${env.taxIdLabel}`);

console.log(`\n4) Policy — ${env.policy.length} effective rules for jurisdiction ${env.jurisdiction}:`);
const scoped = env.policy.filter((r) => r.jurisdictions);
for (const r of scoped) console.log(`     [${env.jurisdiction}-scoped] ${r.action} → ${r.effect}  (${r.conditionNote ?? ''})`);
console.log(`     ${scoped.length} jurisdiction-scoped, ${env.policy.length - scoped.length} global.`);

console.log('\n5) Collections ladder:');
console.log(`     ${env.collectionStages.join(' → ')}`);

console.log('\nProvisioning is deterministic: the same country always yields this exact environment.\n');
