// Read side of persistence. Where projectWorld writes kernel state to SQL,
// Repositories reads it back and reconstructs kernel-facing views — most
// importantly rehydrating an event-sourced Agreement from its stored event
// stream. Tenant scoping is applied in every query, mirroring the DB's
// deny-by-default RLS (invariant 3): a repository is constructed for one tenant
// and cannot read another's rows.

import { Agreement, type AgreementEvent, type AgreementEventType, type CalendarHold } from '../agreement.ts';
import type { SqlStatement } from './executor.ts';

export type Row = Record<string, unknown>;

/** Query boundary: runs a parameterized statement and returns rows. */
export interface QueryExecutor {
  query(statement: SqlStatement): Promise<Row[]>;
}

/** Canned-row executor for tests: matches on a substring of the SQL text. */
export class FakeQueryExecutor implements QueryExecutor {
  constructor(private readonly routes: Array<{ match: string; rows: (values: unknown[]) => Row[] }>) {}
  async query(statement: SqlStatement): Promise<Row[]> {
    for (const r of this.routes) {
      if (statement.text.includes(r.match)) return r.rows(statement.values);
    }
    throw new Error(`FakeQueryExecutor: no route for: ${statement.text}`);
  }
}

/**
 * Production read executor over node-postgres. `pg` is imported dynamically so
 * the kernel's zero-dep guarantee holds for anyone who doesn't opt in.
 */
export class PgQueryExecutor implements QueryExecutor {
  private clientPromise: Promise<{ query: (t: string, v: unknown[]) => Promise<{ rows: Row[] }> }> | null =
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

  async query(statement: SqlStatement): Promise<Row[]> {
    const c = await this.client();
    const res = await c.query(statement.text, statement.values);
    return res.rows;
  }
}

export interface TrialBalance {
  balances: Record<string, number>;
  net: number;
  balanced: boolean;
}

export class Repositories {
  constructor(
    private readonly q: QueryExecutor,
    private readonly tenantId: string,
  ) {}

  /** Rehydrate one agreement from agreement + agreement_event rows. Null if not this tenant's. */
  async loadAgreement(id: string): Promise<Agreement | null> {
    const [meta] = await this.q.query({
      text: 'select id, tenant_id, guest_id, unit_id from agreement where id = $1 and tenant_id = $2',
      values: [id, this.tenantId],
    });
    if (!meta) return null;

    const eventRows = await this.q.query({
      text: 'select seq, agreement_id, type, at, payload from agreement_event where agreement_id = $1 order by seq',
      values: [id],
    });
    const events: AgreementEvent[] = eventRows.map((r) => ({
      seq: Number(r['seq']),
      agreementId: String(r['agreement_id']),
      type: r['type'] as AgreementEventType,
      at: toIso(r['at']),
      payload: asObject(r['payload']),
    }));

    return Agreement.rehydrate(
      {
        id: String(meta['id']),
        tenantId: String(meta['tenant_id']),
        guestId: String(meta['guest_id']),
        unitId: String(meta['unit_id']),
      },
      events,
    );
  }

  async listAgreementIds(): Promise<string[]> {
    const rows = await this.q.query({
      text: 'select id from agreement where tenant_id = $1 order by id',
      values: [this.tenantId],
    });
    return rows.map((r) => String(r['id']));
  }

  /** Tenant-scoped trial balance from journal_line joined to this tenant's agreements. */
  async loadTrialBalance(): Promise<TrialBalance> {
    const rows = await this.q.query({
      text: `select jl.account as account, sum(jl.debit_cents - jl.credit_cents) as net
             from journal_line jl
             join agreement a on a.id = jl.agreement_id
             where a.tenant_id = $1
             group by jl.account`,
      values: [this.tenantId],
    });
    const balances: Record<string, number> = {};
    let net = 0;
    for (const r of rows) {
      const v = Number(r['net']);
      balances[String(r['account'])] = v;
      net += v;
    }
    return { balances, net, balanced: net === 0 };
  }

  /** Active calendar holds for this tenant's units. */
  async activeHolds(): Promise<CalendarHold[]> {
    const rows = await this.q.query({
      text: `select ch.id, ch.unit_id, ch.holder_id, ch.start_date, ch.end_date, ch.status
             from calendar_hold ch
             join unit u on u.id = ch.unit_id
             where u.tenant_id = $1 and ch.status = 'active'`,
      values: [this.tenantId],
    });
    return rows.map((r) => ({
      id: String(r['id']),
      unitId: String(r['unit_id']),
      holderId: String(r['holder_id']),
      start: toDate(r['start_date']),
      end: toDate(r['end_date']),
      status: 'active' as const,
    }));
  }
}

function asObject(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object') return v as Record<string, unknown>;
  if (typeof v === 'string') return JSON.parse(v) as Record<string, unknown>;
  return {};
}

function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function toDate(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}
