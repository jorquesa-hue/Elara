// Persistence executor boundary. The kernel stays zero-runtime-dependency
// (invariant 7): repositories build *parameterized* SQL statements, and a
// pluggable executor runs them. In production the trusted service-role backend
// (invariant 3 — the Public API is the only API) owns the executor; here the
// RecordingExecutor captures statements so a runnable script can be rendered
// and applied via the DB tooling.

export interface SqlStatement {
  text: string;
  values: unknown[];
}

export interface SqlExecutor {
  exec(statements: readonly SqlStatement[]): Promise<void>;
}

/** Captures statements instead of running them. Used by demo-live + tests. */
export class RecordingExecutor implements SqlExecutor {
  readonly statements: SqlStatement[] = [];
  async exec(statements: readonly SqlStatement[]): Promise<void> {
    this.statements.push(...statements);
  }
}

/** Render a single value as a SQL literal (for producing a runnable script). */
export function renderLiteral(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`cannot render non-finite number: ${v}`);
    return String(v);
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  // Everything else (incl. pre-stringified JSON for ::jsonb columns) is a
  // string literal with single quotes doubled.
  return `'${String(v).replace(/'/g, "''")}'`;
}

/**
 * Inline a parameterized statement into a standalone SQL string. Replaces
 * $n placeholders high-to-low so $10 is not shadowed by $1. Intended for
 * script generation, not for a live query path (use parameters there).
 */
export function renderStatement(stmt: SqlStatement): string {
  let text = stmt.text;
  for (let i = stmt.values.length; i >= 1; i--) {
    const lit = renderLiteral(stmt.values[i - 1]);
    text = text.replace(new RegExp(`\\$${i}\\b`, 'g'), () => lit);
  }
  return text.endsWith(';') ? text : text + ';';
}

export function renderScript(statements: readonly SqlStatement[]): string {
  return statements.map(renderStatement).join('\n');
}

/**
 * Production executor over node-postgres. Optional: `pg` is not a kernel
 * dependency and is imported dynamically only when this is actually used, so
 * the zero-dep guarantee holds for everyone who does not opt in. Run
 * `npm i pg` and pass a connection string to use it.
 */
export class PgExecutor implements SqlExecutor {
  private clientPromise: Promise<{ query: (t: string, v: unknown[]) => Promise<unknown> }> | null =
    null;

  constructor(private readonly connectionString: string) {}

  private async client() {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        // @ts-expect-error optional peer dependency, resolved at runtime
        const pg = await import('pg');
        const Client = pg.default?.Client ?? pg.Client;
        const c = new Client({ connectionString: this.connectionString });
        await c.connect();
        return c;
      })();
    }
    return this.clientPromise;
  }

  /** Runs the batch in a single transaction; the deferred balance constraint
   *  is validated at COMMIT (invariant 6). */
  async exec(statements: readonly SqlStatement[]): Promise<void> {
    const c = await this.client();
    await c.query('begin', []);
    try {
      for (const s of statements) await c.query(s.text, s.values);
      await c.query('commit', []);
    } catch (e) {
      await c.query('rollback', []);
      throw e;
    }
  }
}
