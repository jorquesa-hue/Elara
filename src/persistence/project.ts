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
import type { ExceptionItem } from '../exception-queue.ts';
import type { PeriodLockRecord } from '../period-lock.ts';

export interface WorldData {
  tenants: Array<{
    id: string; name: string;
    displayName?: string; locale?: string; currency?: string; timezone?: string;
    businessStructure?: string; country?: string; jurisdiction?: string; brandColor?: string; logoDataUrl?: string; tagline?: string; siteContent?: Record<string, unknown>;
  }>;
  units: Array<{ id: string; tenantId: string; label: string; code?: string; active?: boolean; typeId?: string; propertyId?: string }>;
  /** Floorplans/unit types — parents of typed units, emitted first. */
  unitTypes?: Array<{ id: string; tenantId: string; code: string; name: string; bedrooms?: number; bathrooms?: number; maxGuests?: number; areaSqm?: number; baseRentCents?: number; description?: string }>;
  /** Properties/communities — parents of units, emitted first. */
  properties?: Array<{ id: string; tenantId: string; code: string; name: string; address?: string; entityId?: string }>;
  guests: Array<{ id: string; tenantId: string; fullName: string; code?: string; email?: string }>;
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
  /** Policy escalations (pending + resolved) — persisted so a restart never
   *  silently drops a parked human decision. Rehydrated items carry no deferred
   *  thunk; approval then records the decision without auto-executing. */
  exceptions?: readonly ExceptionItem[];
  periodLocks?: readonly PeriodLockRecord[];
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
  // --- feature wire-up: revenue (#1), procurement (#2), roommate (#9), crm (#20)
  pricingRules?: Array<{
    id: string; tenantId: string; name: string; baseCents: number; minCents?: number; maxCents?: number;
    weekendFactorBps?: number; occupancyTiers?: unknown[]; leadTimeTiers?: unknown[]; losDiscounts?: unknown[]; seasons?: unknown[];
  }>;
  purchaseOrders?: Array<{
    id: string; tenantId: string; vendorId: string; entityId?: string; createdAt: string; expectedAt?: string;
    currency: string; totalCents: number; status: string; billedCents: number;
    approvedAt?: string; receivedAt?: string; closedAt?: string; cancelledAt?: string; memo?: string;
    lines: ReadonlyArray<{ description: string; account: string; amountCents: number }>;
  }>;
  budgets?: Array<{
    id: string; tenantId: string; account: string; periodStart: string; periodEnd: string; amountCents: number; label?: string;
  }>;
  prospects?: Array<{
    id: string; tenantId: string; name: string; partyId?: string; preferences: Record<string, unknown>;
  }>;
  leads?: Array<{
    id: string; tenantId: string; name: string; source?: string; stage: string; estValueCents: number;
    partyId?: string; createdAt: string; updatedAt: string; stageAt: Record<string, unknown>; lostReason?: string;
  }>;
  // --- full persistence: platform users, custom roles, e-sign, connectors -----
  users?: Array<{ id: string; tenantId: string; code: string; displayName: string; roleId: string; active: boolean }>;
  customRoles?: Array<{ tenantId: string; roleId: string; name: string; description?: string; permissions: readonly string[] }>;
  integrations?: Array<{
    id: string; tenantId: string; kind: string; provider: string; status: string;
    config: Record<string, unknown>; secretRef?: string; createdAt: string;
  }>;
  connectorCommands?: Array<{
    id: string; tenantId: string; integrationId: string; action: string; payload: Record<string, unknown>;
    status: string; createdAt: string; dispatchedAt?: string; resolvedAt?: string; result?: Record<string, unknown>;
  }>;
  notifications?: Array<{
    id: string; tenantId: string; channel: string; to: string; kind: string; data: Record<string, unknown>;
    status: string; createdAt: string; sentAt?: string; failedReason?: string; providerRef?: string;
  }>;
  signatureEnvelopes?: Array<{
    id: string; tenantId: string; documentName: string; provider: string; providerRef?: string;
    leadId?: string; agreementId?: string; signers: readonly unknown[]; status: string;
    createdAt: string; sentAt?: string; completedAt?: string; voidReason?: string; declineReason?: string;
  }>;
}

function stmt(text: string, values: unknown[]): SqlStatement {
  return { text, values };
}

/** Produce INSERTs in foreign-key-safe order. */
export function projectWorld(w: WorldData): SqlStatement[] {
  const out: SqlStatement[] = [];

  for (const t of w.tenants) {
    out.push(
      stmt(
        'insert into tenant (id, name, display_name, locale, currency, timezone, business_structure, country, jurisdiction, brand_color, logo_data_url, tagline, site_content) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb) on conflict (id) do update set name = excluded.name, display_name = excluded.display_name, locale = excluded.locale, currency = excluded.currency, timezone = excluded.timezone, business_structure = excluded.business_structure, country = excluded.country, jurisdiction = excluded.jurisdiction, brand_color = excluded.brand_color, logo_data_url = excluded.logo_data_url, tagline = excluded.tagline, site_content = excluded.site_content',
        [t.id, t.name, t.displayName ?? t.name, t.locale ?? 'en', t.currency ?? 'USD', t.timezone ?? 'UTC', t.businessStructure ?? 'mixed_portfolio', t.country ?? 'US', t.jurisdiction ?? 'US', t.brandColor ?? null, t.logoDataUrl ?? null, t.tagline ?? null, t.siteContent ? JSON.stringify(t.siteContent) : null],
      ),
    );
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
  for (const t of w.unitTypes ?? []) {
    out.push(
      stmt(
        'insert into unit_type (id, tenant_id, code, name, bedrooms, bathrooms, max_guests, area_sqm, base_rent_cents, description) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) on conflict (id) do update set code = excluded.code, name = excluded.name, bedrooms = excluded.bedrooms, bathrooms = excluded.bathrooms, max_guests = excluded.max_guests, area_sqm = excluded.area_sqm, base_rent_cents = excluded.base_rent_cents, description = excluded.description',
        [t.id, t.tenantId, t.code, t.name, t.bedrooms ?? null, t.bathrooms ?? null, t.maxGuests ?? null, t.areaSqm ?? null, t.baseRentCents ?? null, t.description ?? null],
      ),
    );
  }
  for (const pr of w.properties ?? []) {
    out.push(
      stmt(
        'insert into property (id, tenant_id, code, name, address, entity_id) values ($1, $2, $3, $4, $5, $6) on conflict (id) do update set code = excluded.code, name = excluded.name, address = excluded.address, entity_id = excluded.entity_id',
        [pr.id, pr.tenantId, pr.code, pr.name, pr.address ?? null, pr.entityId ?? null],
      ),
    );
  }
  for (const u of w.units) {
    out.push(
      stmt('insert into unit (id, tenant_id, label, code, active, type_id, property_id) values ($1, $2, $3, $4, $5, $6, $7) on conflict (id) do update set label = excluded.label, code = excluded.code, active = excluded.active, type_id = excluded.type_id, property_id = excluded.property_id', [u.id, u.tenantId, u.label, u.code ?? u.id, u.active ?? true, u.typeId ?? null, u.propertyId ?? null]),
    );
  }
  for (const g of w.guests) {
    out.push(
      stmt('insert into guest (id, tenant_id, full_name, code, email) values ($1, $2, $3, $4, $5) on conflict (id) do update set full_name = excluded.full_name, code = excluded.code, email = excluded.email', [
        g.id,
        g.tenantId,
        g.fullName,
        g.code ?? g.id,
        g.email ?? null,
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
  // journal_line.id is identity; agreement_id FK is nullable. tenant_id carries
  // the owner for agreement-less (accounts-payable) lines.
  for (const l of w.journalLines) {
    out.push(
      stmt(
        'insert into journal_line (entry_id, account, debit_cents, credit_cents, currency, agreement_id, tenant_id, entity_id, property_id, memo, posted_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
        [l.entryId, l.account, l.debitCents, l.creditCents, l.currency, l.agreementId ?? null, l.tenantId ?? null, l.entityId ?? null, l.propertyId ?? null, l.memo ?? null, l.postedAt],
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
  for (const pr of w.pricingRules ?? []) {
    out.push(
      stmt(
        'insert into pricing_rule (id, tenant_id, name, base_cents, min_cents, max_cents, weekend_factor_bps, occupancy_tiers, lead_time_tiers, los_discounts, seasons) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb) on conflict (id) do update set name = excluded.name, base_cents = excluded.base_cents, min_cents = excluded.min_cents, max_cents = excluded.max_cents, weekend_factor_bps = excluded.weekend_factor_bps, occupancy_tiers = excluded.occupancy_tiers, lead_time_tiers = excluded.lead_time_tiers, los_discounts = excluded.los_discounts, seasons = excluded.seasons',
        [pr.id, pr.tenantId, pr.name, pr.baseCents, pr.minCents ?? null, pr.maxCents ?? null, pr.weekendFactorBps ?? null, JSON.stringify(pr.occupancyTiers ?? []), JSON.stringify(pr.leadTimeTiers ?? []), JSON.stringify(pr.losDiscounts ?? []), JSON.stringify(pr.seasons ?? [])],
      ),
    );
  }
  for (const po of w.purchaseOrders ?? []) {
    out.push(
      stmt(
        'insert into purchase_order (id, tenant_id, vendor_id, entity_id, created_at, expected_at, currency, total_cents, status, billed_cents, approved_at, received_at, closed_at, cancelled_at, memo, lines) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb) on conflict (id) do update set status = excluded.status, billed_cents = excluded.billed_cents, approved_at = excluded.approved_at, received_at = excluded.received_at, closed_at = excluded.closed_at, cancelled_at = excluded.cancelled_at, memo = excluded.memo, lines = excluded.lines',
        [po.id, po.tenantId, po.vendorId, po.entityId ?? null, po.createdAt, po.expectedAt ?? null, po.currency, po.totalCents, po.status, po.billedCents, po.approvedAt ?? null, po.receivedAt ?? null, po.closedAt ?? null, po.cancelledAt ?? null, po.memo ?? null, JSON.stringify(po.lines ?? [])],
      ),
    );
  }
  for (const b of w.budgets ?? []) {
    out.push(
      stmt(
        'insert into budget (id, tenant_id, account, period_start, period_end, amount_cents, label) values ($1, $2, $3, $4, $5, $6, $7) on conflict (id) do update set account = excluded.account, period_start = excluded.period_start, period_end = excluded.period_end, amount_cents = excluded.amount_cents, label = excluded.label',
        [b.id, b.tenantId, b.account, b.periodStart, b.periodEnd, b.amountCents, b.label ?? null],
      ),
    );
  }
  for (const p of w.prospects ?? []) {
    out.push(
      stmt(
        'insert into roommate_prospect (id, tenant_id, name, party_id, preferences) values ($1, $2, $3, $4, $5::jsonb) on conflict (id) do update set name = excluded.name, party_id = excluded.party_id, preferences = excluded.preferences',
        [p.id, p.tenantId, p.name, p.partyId ?? null, JSON.stringify(p.preferences ?? {})],
      ),
    );
  }
  for (const l of w.leads ?? []) {
    out.push(
      stmt(
        'insert into crm_lead (id, tenant_id, name, source, stage, est_value_cents, party_id, created_at, updated_at, stage_at, lost_reason) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11) on conflict (id) do update set name = excluded.name, source = excluded.source, stage = excluded.stage, est_value_cents = excluded.est_value_cents, party_id = excluded.party_id, updated_at = excluded.updated_at, stage_at = excluded.stage_at, lost_reason = excluded.lost_reason',
        [l.id, l.tenantId, l.name, l.source ?? null, l.stage, l.estValueCents, l.partyId ?? null, l.createdAt, l.updatedAt, JSON.stringify(l.stageAt ?? {}), l.lostReason ?? null],
      ),
    );
  }
  for (const u of w.users ?? []) {
    out.push(
      stmt(
        'insert into app_user (id, tenant_id, code, display_name, role_id, active) values ($1, $2, $3, $4, $5, $6) on conflict (id) do update set code = excluded.code, display_name = excluded.display_name, role_id = excluded.role_id, active = excluded.active',
        [u.id, u.tenantId, u.code, u.displayName, u.roleId, u.active],
      ),
    );
  }
  for (const cr of w.customRoles ?? []) {
    out.push(
      stmt(
        'insert into custom_role (tenant_id, role_id, name, description, permissions) values ($1, $2, $3, $4, $5::jsonb) on conflict (tenant_id, role_id) do update set name = excluded.name, description = excluded.description, permissions = excluded.permissions',
        [cr.tenantId, cr.roleId, cr.name, cr.description ?? null, JSON.stringify(cr.permissions ?? [])],
      ),
    );
  }
  for (const it of w.integrations ?? []) {
    out.push(
      stmt(
        'insert into integration (id, tenant_id, kind, provider, status, config, secret_ref, created_at) values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8) on conflict (id) do update set status = excluded.status, config = excluded.config, secret_ref = excluded.secret_ref',
        [it.id, it.tenantId, it.kind, it.provider, it.status, JSON.stringify(it.config ?? {}), it.secretRef ?? null, it.createdAt],
      ),
    );
  }
  for (const c of w.connectorCommands ?? []) {
    out.push(
      stmt(
        'insert into connector_command (id, tenant_id, integration_id, action, payload, status, created_at, dispatched_at, resolved_at, result) values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10::jsonb) on conflict (id) do update set status = excluded.status, dispatched_at = excluded.dispatched_at, resolved_at = excluded.resolved_at, result = excluded.result',
        [c.id, c.tenantId, c.integrationId, c.action, JSON.stringify(c.payload ?? {}), c.status, c.createdAt, c.dispatchedAt ?? null, c.resolvedAt ?? null, c.result === undefined ? null : JSON.stringify(c.result)],
      ),
    );
  }
  for (const n of w.notifications ?? []) {
    out.push(
      stmt(
        'insert into notification (id, tenant_id, channel, recipient, kind, data, status, created_at, sent_at, failed_reason, provider_ref) values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11) on conflict (id) do update set recipient = excluded.recipient, data = excluded.data, status = excluded.status, sent_at = excluded.sent_at, failed_reason = excluded.failed_reason, provider_ref = excluded.provider_ref',
        [n.id, n.tenantId, n.channel, n.to, n.kind, JSON.stringify(n.data ?? {}), n.status, n.createdAt, n.sentAt ?? null, n.failedReason ?? null, n.providerRef ?? null],
      ),
    );
  }
  for (const e of w.signatureEnvelopes ?? []) {
    out.push(
      stmt(
        'insert into signature_envelope (id, tenant_id, document_name, provider, provider_ref, lead_id, agreement_id, signers, status, created_at, sent_at, completed_at, void_reason, decline_reason) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14) on conflict (id) do update set provider_ref = excluded.provider_ref, signers = excluded.signers, status = excluded.status, sent_at = excluded.sent_at, completed_at = excluded.completed_at, void_reason = excluded.void_reason, decline_reason = excluded.decline_reason',
        [e.id, e.tenantId, e.documentName, e.provider, e.providerRef ?? null, e.leadId ?? null, e.agreementId ?? null, JSON.stringify(e.signers ?? []), e.status, e.createdAt, e.sentAt ?? null, e.completedAt ?? null, e.voidReason ?? null, e.declineReason ?? null],
      ),
    );
  }
  for (const x of w.exceptions ?? []) {
    out.push(
      stmt(
        'insert into exception_item (id, action, ctx, reason, status, created_at, resolved_at, resolved_by, note) values ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9) on conflict (id) do update set status = excluded.status, resolved_at = excluded.resolved_at, resolved_by = excluded.resolved_by, note = excluded.note',
        [x.id, x.action, JSON.stringify(x.ctx ?? {}), x.reason, x.status, x.createdAt, x.resolvedAt ?? null, x.resolvedBy ?? null, x.note ?? null],
      ),
    );
  }
  for (const pl of w.periodLocks ?? []) {
    out.push(
      stmt(
        'insert into period_lock (tenant_id, period, status, closed_at, closed_by, reopened_at, reopened_by) values ($1, $2, $3, $4, $5, $6, $7) on conflict (tenant_id, period) do update set status = excluded.status, closed_at = excluded.closed_at, closed_by = excluded.closed_by, reopened_at = excluded.reopened_at, reopened_by = excluded.reopened_by',
        [pl.tenantId, pl.period, pl.status, pl.closedAt ?? null, pl.closedBy ?? null, pl.reopenedAt ?? null, pl.reopenedBy ?? null],
      ),
    );
  }
  // action_log.seq is identity; insert in the runtime's recorded order.
  for (const r of [...w.actionLog].sort((x, y) => x.seq - y.seq)) {
    out.push(
      stmt(
        'insert into action_log (tenant_id, at, actor, action, effect, rule_id, outcome, reason, exception_id) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
        [r.tenantId, r.at, r.actor, r.action, r.effect, r.ruleId ?? null, r.outcome, r.reason, r.exceptionId ?? null],
      ),
    );
  }

  return out;
}
