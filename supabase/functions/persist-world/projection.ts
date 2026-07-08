// FK-ordered world projection — the Edge-runtime twin of
// src/persistence/project.ts. It is a *verbatim* copy of the kernel's
// projectWorld body so the write path inside Supabase produces exactly the
// statements the kernel does. A Node drift-guard test
// (tests/tranche11-edge.test.ts) asserts the two stay byte-identical, so the
// kernel remains the single source of truth (this file must never diverge by
// hand). Self-contained: types are inlined so Deno needs no reach into ../../src.

export interface SqlStatement {
  text: string;
  values: unknown[];
}

interface AgreementEvent {
  seq: number;
  agreementId: string;
  type: string;
  at: string;
  payload?: unknown;
}
interface CalendarHold {
  id: string;
  unitId: string;
  holderId: string;
  start: string;
  end: string;
  status: string;
}
interface JournalLine {
  entryId: string;
  account: string;
  debitCents: number;
  creditCents: number;
  currency: string;
  agreementId?: string | null;
  memo?: string | null;
  postedAt: string;
}
interface InvoiceLine {
  description: string;
  account: string;
  amountCents: number;
}
interface Invoice {
  id: string;
  agreementId: string;
  tenantId: string;
  issuedAt: string;
  dueAt: string;
  currency: string;
  totalCents: number;
  paidCents: number;
  status: string;
  lines: readonly InvoiceLine[];
}
interface Payment {
  id: string;
  invoiceId: string;
  amountCents: number;
  method: string;
  receivedAt: string;
  status: string;
}
interface Deposit {
  id: string;
  agreementId: string;
  amountCents: number;
  currency: string;
  status: string;
  heldAt: string;
  refundedAt?: string | null;
  refundedCents?: number | null;
  deductions?: unknown[];
}
interface ActionLogRecord {
  seq: number;
  at: string;
  actor: string;
  action: string;
  effect: string;
  ruleId?: string | null;
  outcome: string;
  reason: string;
  exceptionId?: string | null;
}

export interface WorldData {
  tenants: Array<{ id: string; name: string }>;
  units: Array<{ id: string; tenantId: string; label: string }>;
  guests: Array<{ id: string; tenantId: string; fullName: string }>;
  ratePlans?: Array<{
    id: string;
    tenantId: string;
    name: string;
    kind: string;
    baseCents: number;
    currency: string;
    depositCents?: number;
  }>;
  agreements: Array<{
    id: string;
    tenantId: string;
    guestId: string;
    unitId: string;
    events: readonly AgreementEvent[];
  }>;
  holds: readonly CalendarHold[];
  journalLines: readonly JournalLine[];
  invoices: readonly Invoice[];
  payments: readonly Payment[];
  deposits: readonly Deposit[];
  actionLog: readonly ActionLogRecord[];
}

function stmt(text: string, values: unknown[]): SqlStatement {
  return { text, values };
}

/** Produce INSERTs in foreign-key-safe order. */
export function projectWorld(w: WorldData): SqlStatement[] {
  const out: SqlStatement[] = [];

  for (const t of w.tenants) {
    out.push(stmt('insert into tenant (id, name) values ($1, $2) on conflict (id) do update set name = excluded.name', [t.id, t.name]));
  }
  for (const u of w.units) {
    out.push(
      stmt('insert into unit (id, tenant_id, label) values ($1, $2, $3) on conflict (id) do update set label = excluded.label', [u.id, u.tenantId, u.label]),
    );
  }
  for (const g of w.guests) {
    out.push(
      stmt('insert into guest (id, tenant_id, full_name) values ($1, $2, $3) on conflict (id) do update set full_name = excluded.full_name', [
        g.id,
        g.tenantId,
        g.fullName,
      ]),
    );
  }
  for (const r of w.ratePlans ?? []) {
    out.push(
      stmt(
        'insert into rate_plan (id, tenant_id, name, kind, base_cents, currency, deposit_cents) values ($1, $2, $3, $4, $5, $6, $7) on conflict (id) do update set name = excluded.name, kind = excluded.kind, base_cents = excluded.base_cents, currency = excluded.currency, deposit_cents = excluded.deposit_cents',
        [r.id, r.tenantId, r.name, r.kind, r.baseCents, r.currency, r.depositCents ?? null],
      ),
    );
  }
  for (const a of w.agreements) {
    out.push(
      stmt('insert into agreement (id, tenant_id, guest_id, unit_id) values ($1, $2, $3, $4) on conflict (id) do nothing', [
        a.id,
        a.tenantId,
        a.guestId,
        a.unitId,
      ]),
    );
  }
  // agreement_event.seq is identity-generated; insert in seq order, payload as jsonb.
  for (const a of w.agreements) {
    for (const e of [...a.events].sort((x, y) => x.seq - y.seq)) {
      out.push(
        stmt(
          'insert into agreement_event (agreement_id, type, at, payload) values ($1, $2, $3, $4::jsonb)',
          [e.agreementId, e.type, e.at, JSON.stringify(e.payload ?? {})],
        ),
      );
    }
  }
  for (const h of w.holds) {
    out.push(
      stmt(
        'insert into calendar_hold (id, unit_id, holder_id, start_date, end_date, status) values ($1, $2, $3, $4, $5, $6) on conflict (id) do update set unit_id = excluded.unit_id, holder_id = excluded.holder_id, start_date = excluded.start_date, end_date = excluded.end_date, status = excluded.status',
        [h.id, h.unitId, h.holderId, h.start, h.end, h.status],
      ),
    );
  }
  // journal_line.id is identity; agreement_id FK is nullable.
  for (const l of w.journalLines) {
    out.push(
      stmt(
        'insert into journal_line (entry_id, account, debit_cents, credit_cents, currency, agreement_id, memo, posted_at) values ($1, $2, $3, $4, $5, $6, $7, $8)',
        [l.entryId, l.account, l.debitCents, l.creditCents, l.currency, l.agreementId ?? null, l.memo ?? null, l.postedAt],
      ),
    );
  }
  for (const inv of w.invoices) {
    out.push(
      stmt(
        'insert into invoice (id, agreement_id, tenant_id, issued_at, due_at, currency, total_cents, paid_cents, status) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict (id) do update set due_at = excluded.due_at, total_cents = excluded.total_cents, paid_cents = excluded.paid_cents, status = excluded.status',
        [inv.id, inv.agreementId, inv.tenantId, inv.issuedAt, inv.dueAt, inv.currency, inv.totalCents, inv.paidCents, inv.status],
      ),
    );
    for (const line of inv.lines) {
      out.push(
        stmt(
          'insert into invoice_line (invoice_id, description, account, amount_cents) values ($1, $2, $3, $4)',
          [inv.id, line.description, line.account, line.amountCents],
        ),
      );
    }
  }
  for (const p of w.payments) {
    out.push(
      stmt(
        'insert into payment (id, invoice_id, amount_cents, method, received_at, status) values ($1, $2, $3, $4, $5, $6) on conflict (id) do update set status = excluded.status',
        [p.id, p.invoiceId, p.amountCents, p.method, p.receivedAt, p.status],
      ),
    );
  }
  for (const d of w.deposits) {
    out.push(
      stmt(
        'insert into deposit (id, agreement_id, amount_cents, currency, status, held_at, refunded_at, refunded_cents, deductions) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb) on conflict (id) do update set status = excluded.status, refunded_at = excluded.refunded_at, refunded_cents = excluded.refunded_cents, deductions = excluded.deductions',
        [d.id, d.agreementId, d.amountCents, d.currency, d.status, d.heldAt, d.refundedAt ?? null, d.refundedCents ?? null, JSON.stringify(d.deductions ?? [])],
      ),
    );
  }
  // action_log.seq is identity; insert in the runtime's recorded order.
  for (const r of [...w.actionLog].sort((x, y) => x.seq - y.seq)) {
    out.push(
      stmt(
        'insert into action_log (at, actor, action, effect, rule_id, outcome, reason, exception_id) values ($1, $2, $3, $4, $5, $6, $7, $8)',
        [r.at, r.actor, r.action, r.effect, r.ruleId ?? null, r.outcome, r.reason, r.exceptionId ?? null],
      ),
    );
  }

  return out;
}
