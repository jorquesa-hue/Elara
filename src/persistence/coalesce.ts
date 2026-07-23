// Coalesce consecutive single-row INSERTs that share identical SQL text into
// multi-row INSERTs. projectWorld() emits rows table-by-table, so same-table
// inserts arrive consecutively with byte-identical text; a large world of
// thousands of one-row statements collapses to a few dozen multi-row ones.
//
// This is the reference implementation. The persist-world Edge Function carries
// a byte-identical inline copy (supabase/functions/persist-world/index.ts) —
// the edge is where the flush is actually applied, and reducing the statement
// count is the difference between finishing inside the edge's execution budget
// and timing out (which rolls the whole batch back, so nothing persists). Keep
// the two copies in sync.

import type { SqlStatement } from './executor.ts';

/**
 * Merge runs of consecutive identical-text single-row INSERTs into multi-row
 * INSERTs. Placeholders are renumbered per merged statement, and each run is
 * chunked so the parameter count stays well under Postgres's 65535-per-statement
 * limit. The trailing ON CONFLICT clause (upsert or do-nothing) is preserved.
 * Non-insert statements, lone inserts, and anything that doesn't match the
 * single-tuple insert shape pass through untouched and in order.
 */
export function coalesceStatements(statements: SqlStatement[]): SqlStatement[] {
  const out: SqlStatement[] = [];
  let i = 0;
  while (i < statements.length) {
    const cur = statements[i]!;
    const m = /^(insert into \w+ \([^)]*\) values )\([^)]*\)(.*)$/is.exec(cur.text);
    // Gather the run of consecutive statements with identical text.
    let j = i;
    while (j < statements.length && statements[j]!.text === cur.text) j++;
    const run = statements.slice(i, j);
    i = j;
    if (!m || run.length === 1 || cur.values.length === 0) {
      out.push(...run);
      continue;
    }
    const prefix = m[1]!;
    const suffix = m[2]!;
    const cols = cur.values.length;
    const maxRows = Math.max(1, Math.floor(60000 / cols));
    for (let k = 0; k < run.length; k += maxRows) {
      const chunk = run.slice(k, k + maxRows);
      const values: unknown[] = [];
      const tuples: string[] = [];
      let p = 1;
      for (const st of chunk) {
        tuples.push('(' + st.values.map(() => '$' + p++).join(', ') + ')');
        for (const v of st.values) values.push(v);
      }
      out.push({ text: prefix + tuples.join(', ') + suffix, values });
    }
  }
  return out;
}
