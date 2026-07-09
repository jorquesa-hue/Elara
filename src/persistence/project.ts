// World projection: fold the accumulated in-memory kernel state into an
// FK-ordered batch of parameterized INSERTs. This is the event-sourcing bridge
// — the same records the kernel produced (agreement events, journal lines,
// holds) are replayed into Postgres. Pure data in, statements out; no kernel
// class imported, so it is trivially testable and carries zero deps.
//
// Idempotency: the append-only streams (agreement_event, journal_line,
// action_log) and invoice_line carry no natural key and are NEVER re-sent — the
// App's high-water mark (App.persist) slices only new rows into the world. The
// state/parent tables instead upsert (ON CONFLICT), so a repeated flush is safe
// and reflects the latest status (invoice paid, deposit refunded, hold
// released) without violating the append-only triggers on the three streams.

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
    guestId: string | null; // legacy; null when the resident is identified by party
    unitId: string;
    events: readonly AgreementEvent[];
  }>;
  holds: readonly CalendarHold[];
  journalLines: readonly JournalLine[];
  invoices: readonly Invoice[];
  payments: readonly Payment[];
  deposits: readonly Deposit[];
  actionLog: readonly ActionLogRecord[];
  // --- master-data reshape v2 (all optional → backward compatible) ---------
  legalEntities?: Array<{ id: string; tenantId: string; role: string; name: string; taxId?: string }>;
  parties?: Array<{
    id: string; tenantId: string; kind: string; displayName: string;
    legalName?: string; taxId?: string; email?: string; phone?: string;
    attributes?: Record<string, unknown>;
  }>;
  spaces?: Array<{
    id: string; tenantId: string; parentId?: string; type: string; code: string;
    label: string; leasable: boolean; capacity?: number; attributes?: Record<string, unknown>;
  }>;
  chargeTypes?: Array<{
    id: string; tenantId: string; code: string; name: string;
    receivingEntityId: string; glAccount: string; recurring: boolean;
  }>;
  agreementParties?: Array<{
    agreementId: string; partyId: string; role: string; sharePct?: number; from?: string; to?: string;
  }>;
  bills?: Array<{
    id: string; tenantId: string; payeeId: string; entityId?: string;
    issuedAt: string; dueAt: string; currency: string; totalCents: number;
    paidCents: number; status: string; memo?: string;
    lines: ReadonlyArray<{ description: string; account: string; amountCents: number }>;
  }>;
  apPayments?: Array<{
    id: string; billId: string; amountCents: number; method: string; paidAt: string; status: string;
  }>;
  workOrders?: Array<{
    id: string; tenantId: string; spaceId?: string; title: string; description?: string;
    category?: string; priority: string; status: string; requestedByPartyId?: string;
    assignedVendorPartyId?: string; billId?: string; openedAt: string; assignedAt?: string;
    startedAt?: string; closedAt?: string; resolution?: string; cancelReason?: string;
  }>;
  reservations?: Array<{
    id: string; tenantId: string; spaceId: string; holderPartyId: string; start: string; end: string;
    priceCents?: number; currency?: string; status: string; reservedAt: string; cancelledAt?: string; note?: string;
  }>;
  inspections?: Array<{
    id: string; tenantId: string; agreementId: string; spaceId?: string; kind: string; status: string;
    scheduledAt?: string; conductedAt?: string; conductedByPartyId?: string;
    items: ReadonlyArray<{ area: string; condition: string; note?: string }>; damageCents?: number; createdAt: string;
  }>;
  messageThreads?: Array<{
    id: string; tenantId: string; subject: string; kind: string; status: string;
    agreementId?: string; partyId?: string; createdAt: string; resolvedAt?: string;
  }>;
  messages?: Array<{
    id: string; threadId: string; at: string; authorType: string; authorId: string; body: string; direction: string;
  }>;
  bankTransactions?: Array<{
    id: string; tenantId: string; bankAccountId?: string; postedAt: string; amountCents: number;
    description: string; reference?: string; status: string; matchedType?: string; matchedId?: string; matchedAt?: string;
  }>;
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
  for (const e of w.legalEntities ?? []) {
    out.push(
      stmt(
        'insert into legal_entity (id, tenant_id, role, name, tax_id) values ($1, $2, $3, $4, $5) on conflict (id) do update set role = excluded.role, name = excluded.name, tax_id = excluded.tax_id',
        [e.id, e.tenantId, e.role, e.name, e.taxId ?? null],
      ),
    );
  }
  for (const p of w.parties ?? []) {
    out.push(
      stmt(
        'insert into party (id, tenant_id, kind, display_name, legal_name, tax_id, email, phone, attributes) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb) on conflict (id) do update set kind = excluded.kind, display_name = excluded.display_name, legal_name = excluded.legal_name, tax_id = excluded.tax_id, email = excluded.email, phone = excluded.phone, attributes = excluded.attributes',
        [p.id, p.tenantId, p.kind, p.displayName, p.legalName ?? null, p.taxId ?? null, p.email ?? null, p.phone ?? null, JSON.stringify(p.attributes ?? {})],
      ),
    );
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
  // space is self-referencing (parent_id → space): emit parents before children.
  {
    const emitted = new Set<string>();
    const remaining = [...(w.spaces ?? [])];
    let guard = remaining.length * remaining.length + 1;
    const emit = (s: (typeof remaining)[number]) => {
      emitted.add(s.id);
      out.push(
        stmt(
          'insert into space (id, tenant_id, parent_id, type, code, label, leasable, capacity, attributes) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb) on conflict (id) do update set parent_id = excluded.parent_id, type = excluded.type, code = excluded.code, label = excluded.label, leasable = excluded.leasable, capacity = excluded.capacity, attributes = excluded.attributes',
          [s.id, s.tenantId, s.parentId ?? null, s.type, s.code, s.label, s.leasable, s.capacity ?? null, JSON.stringify(s.attributes ?? {})],
        ),
      );
    };
    while (remaining.length && guard-- > 0) {
      const idx = remaining.findIndex((s) => !s.parentId || emitted.has(s.parentId));
      const s = remaining.splice(idx === -1 ? 0 : idx, 1)[0]!;
      emit(s); // idx === -1 (cycle/missing parent) falls back to insertion order
    }
  }
  for (const c of w.chargeTypes ?? []) {
    out.push(
      stmt(
        'insert into charge_type (id, tenant_id, code, name, receiving_entity_id, gl_account, recurring) values ($1, $2, $3, $4, $5, $6, $7) on conflict (id) do update set code = excluded.code, name = excluded.name, receiving_entity_id = excluded.receiving_entity_id, gl_account = excluded.gl_account, recurring = excluded.recurring',
        [c.id, c.tenantId, c.code, c.name, c.receivingEntityId, c.glAccount, c.recurring],
      ),
    );
  }
  for (const a of w.agreements) {
    out.push(
      stmt('insert into agreement (id, tenant_id, guest_id, unit_id) values ($1, $2, $3, $4) on conflict (id) do nothing', [
        a.id,
        a.tenantId,
        a.guestId ?? null,
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
  for (const ap of w.agreementParties ?? []) {
    out.push(
      stmt(
        'insert into agreement_party (agreement_id, party_id, role, share_pct, from_date, to_date) values ($1, $2, $3, $4, $5, $6) on conflict (agreement_id, party_id, role) do update set share_pct = excluded.share_pct, from_date = excluded.from_date, to_date = excluded.to_date',
        [ap.agreementId, ap.partyId, ap.role, ap.sharePct ?? null, ap.from ?? null, ap.to ?? null],
      ),
    );
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
        'insert into invoice (id, agreement_id, tenant_id, issued_at, due_at, currency, total_cents, paid_cents, status, receiving_entity_id) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) on conflict (id) do update set due_at = excluded.due_at, total_cents = excluded.total_cents, paid_cents = excluded.paid_cents, status = excluded.status, receiving_entity_id = excluded.receiving_entity_id',
        [inv.id, inv.agreementId, inv.tenantId, inv.issuedAt, inv.dueAt, inv.currency, inv.totalCents, inv.paidCents, inv.status, inv.receivingEntityId ?? null],
      ),
    );
    for (const line of inv.lines) {
      out.push(
        stmt(
          'insert into invoice_line (invoice_id, description, account, amount_cents, charge_type) values ($1, $2, $3, $4, $5)',
          [inv.id, line.description, line.account, line.amountCents, line.chargeType ?? null],
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
  // accounts payable — bill (upsert) then its lines (append-only) then payments.
  for (const b of w.bills ?? []) {
    out.push(
      stmt(
        'insert into bill (id, tenant_id, payee_id, entity_id, issued_at, due_at, currency, total_cents, paid_cents, status, memo) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) on conflict (id) do update set paid_cents = excluded.paid_cents, status = excluded.status, memo = excluded.memo',
        [b.id, b.tenantId, b.payeeId, b.entityId ?? null, b.issuedAt, b.dueAt, b.currency, b.totalCents, b.paidCents, b.status, b.memo ?? null],
      ),
    );
    for (const line of b.lines) {
      out.push(
        stmt(
          'insert into bill_line (bill_id, description, account, amount_cents) values ($1, $2, $3, $4)',
          [b.id, line.description, line.account, line.amountCents],
        ),
      );
    }
  }
  for (const p of w.apPayments ?? []) {
    out.push(
      stmt(
        'insert into ap_payment (id, bill_id, amount_cents, method, paid_at, status) values ($1, $2, $3, $4, $5, $6) on conflict (id) do update set status = excluded.status',
        [p.id, p.billId, p.amountCents, p.method, p.paidAt, p.status],
      ),
    );
  }
  for (const wo of w.workOrders ?? []) {
    out.push(
      stmt(
        'insert into work_order (id, tenant_id, space_id, title, description, category, priority, status, requested_by_party_id, assigned_vendor_party_id, bill_id, opened_at, assigned_at, started_at, closed_at, resolution, cancel_reason) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) on conflict (id) do update set space_id = excluded.space_id, title = excluded.title, description = excluded.description, category = excluded.category, priority = excluded.priority, status = excluded.status, requested_by_party_id = excluded.requested_by_party_id, assigned_vendor_party_id = excluded.assigned_vendor_party_id, bill_id = excluded.bill_id, assigned_at = excluded.assigned_at, started_at = excluded.started_at, closed_at = excluded.closed_at, resolution = excluded.resolution, cancel_reason = excluded.cancel_reason',
        [wo.id, wo.tenantId, wo.spaceId ?? null, wo.title, wo.description ?? null, wo.category ?? null, wo.priority, wo.status, wo.requestedByPartyId ?? null, wo.assignedVendorPartyId ?? null, wo.billId ?? null, wo.openedAt, wo.assignedAt ?? null, wo.startedAt ?? null, wo.closedAt ?? null, wo.resolution ?? null, wo.cancelReason ?? null],
      ),
    );
  }
  for (const r of w.reservations ?? []) {
    out.push(
      stmt(
        'insert into reservation (id, tenant_id, space_id, holder_party_id, start_at, end_at, price_cents, currency, status, reserved_at, cancelled_at, note) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) on conflict (id) do update set status = excluded.status, cancelled_at = excluded.cancelled_at, price_cents = excluded.price_cents, note = excluded.note',
        [r.id, r.tenantId, r.spaceId, r.holderPartyId, r.start, r.end, r.priceCents ?? null, r.currency ?? null, r.status, r.reservedAt, r.cancelledAt ?? null, r.note ?? null],
      ),
    );
  }
  for (const insp of w.inspections ?? []) {
    out.push(
      stmt(
        'insert into inspection (id, tenant_id, agreement_id, space_id, kind, status, scheduled_at, conducted_at, conducted_by_party_id, items, damage_cents, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12) on conflict (id) do update set status = excluded.status, conducted_at = excluded.conducted_at, conducted_by_party_id = excluded.conducted_by_party_id, items = excluded.items, damage_cents = excluded.damage_cents',
        [insp.id, insp.tenantId, insp.agreementId, insp.spaceId ?? null, insp.kind, insp.status, insp.scheduledAt ?? null, insp.conductedAt ?? null, insp.conductedByPartyId ?? null, JSON.stringify(insp.items ?? []), insp.damageCents ?? null, insp.createdAt],
      ),
    );
  }
  for (const th of w.messageThreads ?? []) {
    out.push(
      stmt(
        'insert into message_thread (id, tenant_id, subject, kind, status, agreement_id, party_id, created_at, resolved_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict (id) do update set subject = excluded.subject, status = excluded.status, resolved_at = excluded.resolved_at',
        [th.id, th.tenantId, th.subject, th.kind, th.status, th.agreementId ?? null, th.partyId ?? null, th.createdAt, th.resolvedAt ?? null],
      ),
    );
  }
  for (const m of w.messages ?? []) {
    out.push(
      stmt(
        'insert into message (id, thread_id, at, author_type, author_id, body, direction) values ($1, $2, $3, $4, $5, $6, $7) on conflict (id) do nothing',
        [m.id, m.threadId, m.at, m.authorType, m.authorId, m.body, m.direction],
      ),
    );
  }
  for (const bt of w.bankTransactions ?? []) {
    out.push(
      stmt(
        'insert into bank_transaction (id, tenant_id, bank_account_id, posted_at, amount_cents, description, reference, status, matched_type, matched_id, matched_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) on conflict (id) do update set status = excluded.status, matched_type = excluded.matched_type, matched_id = excluded.matched_id, matched_at = excluded.matched_at',
        [bt.id, bt.tenantId, bt.bankAccountId ?? null, bt.postedAt, bt.amountCents, bt.description, bt.reference ?? null, bt.status, bt.matchedType ?? null, bt.matchedId ?? null, bt.matchedAt ?? null],
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
