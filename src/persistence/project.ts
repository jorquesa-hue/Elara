// World projection: fold the accumulated in-memory kernel state into an
// FK-ordered batch of parameterized INSERTs. This is the event-sourcing bridge
// — the same records the kernel produced (agreement events, journal lines,
// holds) are replayed into Postgres. Pure data in, statements out; no kernel
// class imported, so it is trivially testable and carries zero deps.

import type { SqlStatement } from './executor.ts';
import type { AgreementEvent } from '../agreement.ts';
import type { CalendarHold } from '../agreement.ts';
import type { JournalLine } from '../ledger.ts';
import type { Invoice } from '../billing.ts';
import type { Payment } from '../payments.ts';
import type { Deposit } from '../deposits.ts';
import type { ActionLogRecord } from '../agent-runtime.ts';

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
    out.push(stmt('insert into tenant (id, name) values ($1, $2)', [t.id, t.name]));
  }
  for (const u of w.units) {
    out.push(
      stmt('insert into unit (id, tenant_id, label) values ($1, $2, $3)', [u.id, u.tenantId, u.label]),
    );
  }
  for (const g of w.guests) {
    out.push(
      stmt('insert into guest (id, tenant_id, full_name) values ($1, $2, $3)', [
        g.id,
        g.tenantId,
        g.fullName,
      ]),
    );
  }
  for (const r of w.ratePlans ?? []) {
    out.push(
      stmt(
        'insert into rate_plan (id, tenant_id, name, kind, base_cents, currency, deposit_cents) values ($1, $2, $3, $4, $5, $6, $7)',
        [r.id, r.tenantId, r.name, r.kind, r.baseCents, r.currency, r.depositCents ?? null],
      ),
    );
  }
  for (const a of w.agreements) {
    out.push(
      stmt('insert into agreement (id, tenant_id, guest_id, unit_id) values ($1, $2, $3, $4)', [
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
        'insert into calendar_hold (id, unit_id, holder_id, start_date, end_date, status) values ($1, $2, $3, $4, $5, $6)',
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
        'insert into invoice (id, agreement_id, tenant_id, issued_at, due_at, currency, total_cents, paid_cents, status) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
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
        'insert into payment (id, invoice_id, amount_cents, method, received_at, status) values ($1, $2, $3, $4, $5, $6)',
        [p.id, p.invoiceId, p.amountCents, p.method, p.receivedAt, p.status],
      ),
    );
  }
  for (const d of w.deposits) {
    out.push(
      stmt(
        'insert into deposit (id, agreement_id, amount_cents, currency, status, held_at, refunded_at, refunded_cents, deductions) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)',
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
