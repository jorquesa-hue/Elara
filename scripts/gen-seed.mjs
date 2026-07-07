// Regenerates supabase/policy_rule.seed.sql AND migration 20260707170001 from
// the TypeScript rule arrays, which are the single source of truth (invariant
// 5). NEVER hand-edit the generated SQL — edit src/policy-envelope.ts /
// src/collections.ts and re-run: `npx tsx scripts/gen-seed.mjs`.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { POLICY_RULES } from '../src/policy-envelope.ts';
import { COLLECTION_STAGES } from '../src/collections.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

function sqlStr(v) {
  if (v === undefined || v === null) return 'null';
  return `'${String(v).replace(/'/g, "''")}'`;
}

function header(name) {
  return `-- GENERATED FILE — do not edit by hand.
-- Source of truth: src/policy-envelope.ts (POLICY_RULES) and
-- src/collections.ts (COLLECTION_STAGES). Regenerate with:
--   npx tsx scripts/gen-seed.mjs
-- ${name}
`;
}

const lines = [];
lines.push(header('policy_rule + collection_stage seed'));
lines.push('delete from policy_rule;');
lines.push('insert into policy_rule (id, action, effect, description, condition_note, ordinal) values');

const rows = POLICY_RULES.map((r, i) => {
  const cols = [
    sqlStr(r.id),
    sqlStr(r.action),
    sqlStr(r.effect),
    sqlStr(r.description),
    sqlStr(r.conditionNote),
    String(i),
  ];
  return `  (${cols.join(', ')})`;
});
lines.push(rows.join(',\n') + ';');
lines.push('');

// Collection stages ride along in the same seed — also TS-sourced.
lines.push('delete from collection_stage;');
lines.push(
  'insert into collection_stage (id, min_days_overdue, action, policy_action, description, fee_bps, ordinal) values',
);
const stageRows = COLLECTION_STAGES.map((s, i) => {
  const cols = [
    sqlStr(s.id),
    String(s.minDaysOverdue),
    sqlStr(s.action),
    sqlStr(s.policyAction),
    sqlStr(s.description),
    s.feeBps === undefined ? 'null' : String(s.feeBps),
    String(i),
  ];
  return `  (${cols.join(', ')})`;
});
lines.push(stageRows.join(',\n') + ';');
lines.push('');

const body = lines.join('\n');

// The seed file (for local/dev re-seeding) …
writeFileSync(join(root, 'supabase', 'policy_rule.seed.sql'), body);

// … and the migration that ships it. The migration also creates the
// collection_stage table (policy_rule is created in the core schema migration).
const migration = `${header('migration 20260707170001 — policy + collection seed')}
create table if not exists collection_stage (
  id            text primary key,
  min_days_overdue int not null,
  action        text not null,
  policy_action text not null,
  description   text not null,
  fee_bps       int,
  ordinal       int not null
);

${body}`;
writeFileSync(
  join(root, 'supabase', 'migrations', '20260707170001_policy_seed.sql'),
  migration,
);

console.log(
  `gen-seed: wrote ${POLICY_RULES.length} policy rules and ${COLLECTION_STAGES.length} collection stages`,
);
