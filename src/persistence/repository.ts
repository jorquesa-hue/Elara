// Read side of persistence. Where projectWorld writes kernel state to SQL,
// Repositories reads it back and reconstructs kernel-facing views — most
// importantly rehydrating an event-sourced Agreement from its stored event
// stream. Tenant scoping is applied in every query, mirroring the DB's
// deny-by-default RLS (invariant 3): a repository is constructed for one tenant
// and cannot read another's rows.

import { Agreement, type AgreementEvent, type AgreementEventType, type CalendarHold } from '../agreement.ts';
import type { SqlStatement } from './executor.ts';
import type { WorldData } from './project.ts';

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
        // Managed Postgres (Supabase et al.) requires TLS. Enable it for any
        // non-local host; rejectUnauthorized:false trusts the provider's cert
        // chain without bundling a CA (standard for Supabase pooler connections).
        // NOTE: on a serverless/IPv6-limited host (Fly), use the CONNECTION POOLER
        // string (IPv4), not the direct db.<ref>.supabase.co host (IPv6-only).
        const isLocal = /@(localhost|127\.0\.0\.1|\[::1\]|\[?::1\]?)[:/]/.test(this.connectionString);
        const c = new Client({
          connectionString: this.connectionString,
          // Fail fast: a black-holed host must surface as an error in seconds
          // (the boot path degrades gracefully on it), never hang the process.
          connectionTimeoutMillis: 10_000,
          ...(isLocal ? {} : { ssl: { rejectUnauthorized: false } }),
        });
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

  /** Tenant-scoped trial balance: lines scoped through their agreement OR — for
   *  agreement-less accounts-payable entries — their own tenant_id tag. */
  async loadTrialBalance(): Promise<TrialBalance> {
    const rows = await this.q.query({
      text: `select jl.account as account, sum(jl.debit_cents - jl.credit_cents) as net
             from journal_line jl
             left join agreement a on a.id = jl.agreement_id
             where a.tenant_id = $1 or jl.tenant_id = $1
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

  /**
   * Read this tenant's ENTIRE world back out of the DB into a WorldData — the
   * inverse of projectWorld and the input to App.rehydrate. This is what a cold
   * start runs: reconstitute everything the persistence layer captured. Every
   * query is tenant-scoped, mirroring RLS. (Master-data code/active and guest
   * email are not stored by the projection, so they are absent here too.)
   */
  async loadWorld(): Promise<WorldData> {
    const tid = this.tenantId;
    const one = async (text: string, values: unknown[] = [tid]) => this.q.query({ text, values });
    const s = (v: unknown) => (v == null ? undefined : String(v));
    const n = (v: unknown) => (v == null ? undefined : Number(v));
    const obj = (v: unknown) => asObject(v);
    const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : typeof v === 'string' ? JSON.parse(v) : []);

    const tenants = (await one('select id, name, display_name, locale, currency, timezone, business_structure, country, jurisdiction, brand_color, logo_data_url, tagline, site_content from tenant where id = $1')).map((r) => ({
      id: String(r['id']), name: String(r['name']), displayName: s(r['display_name']), locale: s(r['locale']), currency: s(r['currency']),
      timezone: s(r['timezone']), businessStructure: s(r['business_structure']), country: s(r['country']), jurisdiction: s(r['jurisdiction']),
      brandColor: s(r['brand_color']), logoDataUrl: s(r['logo_data_url']), tagline: s(r['tagline']),
      siteContent: (r['site_content'] && typeof r['site_content'] === 'object' ? (r['site_content'] as Record<string, unknown>) : undefined),
    }));
    const unitTypes = (await one('select id, tenant_id, code, name, bedrooms, bathrooms, max_guests, area_sqm, base_rent_cents, description from unit_type where tenant_id = $1')).map((r) => ({ id: String(r['id']), tenantId: tid, code: String(r['code']), name: String(r['name']), bedrooms: n(r['bedrooms']), bathrooms: n(r['bathrooms']), maxGuests: n(r['max_guests']), areaSqm: n(r['area_sqm']), baseRentCents: n(r['base_rent_cents']), description: s(r['description']) }));
    const properties = (await one('select id, tenant_id, code, name, address, entity_id from property where tenant_id = $1')).map((r) => ({ id: String(r['id']), tenantId: tid, code: String(r['code']), name: String(r['name']), address: s(r['address']), entityId: s(r['entity_id']) }));
    const units = (await one('select id, tenant_id, label, code, active, type_id, property_id from unit where tenant_id = $1')).map((r) => ({ id: String(r['id']), tenantId: tid, label: String(r['label']), code: s(r['code']), active: r['active'] == null ? undefined : Boolean(r['active']), typeId: s(r['type_id']), propertyId: s(r['property_id']) }));
    const guests = (await one('select id, tenant_id, full_name, code, email from guest where tenant_id = $1')).map((r) => ({ id: String(r['id']), tenantId: tid, fullName: String(r['full_name']), code: s(r['code']), email: s(r['email']) }));
    const ratePlans = (await one('select id, tenant_id, name, kind, base_cents, currency, deposit_cents from rate_plan where tenant_id = $1')).map((r) => ({ id: String(r['id']), tenantId: tid, name: String(r['name']), kind: String(r['kind']), baseCents: Number(r['base_cents']), currency: String(r['currency']), depositCents: n(r['deposit_cents']) }));
    const users = (await one('select id, tenant_id, code, display_name, role_id, active from app_user where tenant_id = $1')).map((r) => ({ id: String(r['id']), tenantId: tid, code: String(r['code']), displayName: String(r['display_name']), roleId: String(r['role_id']), active: Boolean(r['active']) }));
    const customRoles = (await one('select tenant_id, role_id, name, description, permissions from custom_role where tenant_id = $1')).map((r) => ({ tenantId: tid, roleId: String(r['role_id']), name: String(r['name']), description: s(r['description']), permissions: arr(r['permissions']) as string[] }));
    const legalEntities = (await one('select id, tenant_id, role, name, tax_id from legal_entity where tenant_id = $1')).map((r) => ({ id: String(r['id']), tenantId: tid, role: String(r['role']), name: String(r['name']), taxId: s(r['tax_id']) }));
    const parties = (await one('select id, tenant_id, kind, display_name, legal_name, tax_id, email, phone, attributes from party where tenant_id = $1')).map((r) => ({ id: String(r['id']), tenantId: tid, kind: String(r['kind']), displayName: String(r['display_name']), legalName: s(r['legal_name']), taxId: s(r['tax_id']), email: s(r['email']), phone: s(r['phone']), attributes: obj(r['attributes']) }));
    const spaces = (await one('select id, tenant_id, parent_id, type, code, label, leasable, capacity, attributes from space where tenant_id = $1')).map((r) => ({ id: String(r['id']), tenantId: tid, parentId: s(r['parent_id']), type: String(r['type']), code: String(r['code']), label: String(r['label']), leasable: Boolean(r['leasable']), capacity: n(r['capacity']), attributes: obj(r['attributes']) }));
    const chargeTypes = (await one('select id, tenant_id, code, name, receiving_entity_id, gl_account, recurring from charge_type where tenant_id = $1')).map((r) => ({ id: String(r['id']), tenantId: tid, code: String(r['code']), name: String(r['name']), receivingEntityId: String(r['receiving_entity_id']), glAccount: String(r['gl_account']), recurring: Boolean(r['recurring']) }));

    const agIds = (await one('select id from agreement where tenant_id = $1 order by id')).map((r) => String(r['id']));
    const agreements = [];
    for (const id of agIds) {
      const [meta] = await one('select id, tenant_id, guest_id, unit_id from agreement where id = $1 and tenant_id = $2', [id, tid]);
      const evRows = await one('select seq, agreement_id, type, at, payload from agreement_event where agreement_id = $1 order by seq', [id]);
      agreements.push({
        id, tenantId: tid, guestId: meta!['guest_id'] == null ? null : String(meta!['guest_id']), unitId: String(meta!['unit_id']),
        events: evRows.map((r) => ({ seq: Number(r['seq']), agreementId: id, type: r['type'] as AgreementEventType, at: toIso(r['at']), payload: obj(r['payload']) })),
      });
    }
    const holds = await this.activeHoldsAll();
    // LEFT join: accounts-payable lines have no agreement — they are scoped by
    // their own tenant_id tag (an inner join silently dropped all AP history).
    const journalLines = (await one(`select jl.entry_id, jl.account, jl.debit_cents, jl.credit_cents, jl.currency, jl.agreement_id, jl.tenant_id, jl.entity_id, jl.property_id, jl.memo, jl.posted_at from journal_line jl left join agreement a on a.id = jl.agreement_id where a.tenant_id = $1 or jl.tenant_id = $1 order by jl.id`)).map((r) => ({ entryId: String(r['entry_id']), account: String(r['account']), debitCents: Number(r['debit_cents']), creditCents: Number(r['credit_cents']), currency: String(r['currency']), agreementId: s(r['agreement_id']) ?? null, tenantId: s(r['tenant_id']), entityId: s(r['entity_id']), propertyId: s(r['property_id']), memo: s(r['memo']) ?? null, postedAt: toIso(r['posted_at']) }));

    const invRows = await one('select id, agreement_id, tenant_id, issued_at, due_at, currency, total_cents, paid_cents, status, receiving_entity_id from invoice where tenant_id = $1');
    const invoices = [];
    for (const r of invRows) {
      const lines = (await one('select description, account, amount_cents, charge_type from invoice_line where invoice_id = $1', [String(r['id'])])).map((l) => ({ description: String(l['description']), account: String(l['account']), amountCents: Number(l['amount_cents']), chargeType: s(l['charge_type']) }));
      invoices.push({ id: String(r['id']), agreementId: String(r['agreement_id']), tenantId: tid, issuedAt: toIso(r['issued_at']), dueAt: toIso(r['due_at']), currency: String(r['currency']), totalCents: Number(r['total_cents']), paidCents: Number(r['paid_cents']), status: String(r['status']), receivingEntityId: s(r['receiving_entity_id']), lines });
    }
    const payments = (await one('select p.id, p.invoice_id, p.amount_cents, p.method, p.received_at, p.status from payment p join invoice i on i.id = p.invoice_id where i.tenant_id = $1')).map((r) => ({ id: String(r['id']), invoiceId: String(r['invoice_id']), amountCents: Number(r['amount_cents']), method: String(r['method']), receivedAt: toIso(r['received_at']), status: String(r['status']) }));
    const deposits = (await one('select d.id, d.agreement_id, d.amount_cents, d.currency, d.status, d.held_at, d.refunded_at, d.refunded_cents, d.deductions, d.cash_account from deposit d join agreement a on a.id = d.agreement_id where a.tenant_id = $1')).map((r) => ({ id: String(r['id']), agreementId: String(r['agreement_id']), amountCents: Number(r['amount_cents']), currency: String(r['currency']), status: String(r['status']), heldAt: toIso(r['held_at']), refundedAt: r['refunded_at'] == null ? null : toIso(r['refunded_at']), refundedCents: n(r['refunded_cents']) ?? null, deductions: arr(r['deductions']), cashAccount: s(r['cash_account']) }));

    const billRows = await one('select id, tenant_id, payee_id, entity_id, property_id, issued_at, due_at, currency, total_cents, paid_cents, status, memo from bill where tenant_id = $1');
    const bills = [];
    for (const r of billRows) {
      const lines = (await one('select description, account, amount_cents from bill_line where bill_id = $1', [String(r['id'])])).map((l) => ({ description: String(l['description']), account: String(l['account']), amountCents: Number(l['amount_cents']) }));
      bills.push({ id: String(r['id']), tenantId: tid, payeeId: String(r['payee_id']), entityId: s(r['entity_id']), propertyId: s(r['property_id']), issuedAt: toIso(r['issued_at']), dueAt: toIso(r['due_at']), currency: String(r['currency']), totalCents: Number(r['total_cents']), paidCents: Number(r['paid_cents']), status: String(r['status']), memo: s(r['memo']), lines });
    }
    const apPayments = (await one('select ap.id, ap.bill_id, ap.amount_cents, ap.method, ap.paid_at, ap.status from ap_payment ap join bill b on b.id = ap.bill_id where b.tenant_id = $1')).map((r) => ({ id: String(r['id']), billId: String(r['bill_id']), amountCents: Number(r['amount_cents']), method: String(r['method']), paidAt: toIso(r['paid_at']), status: String(r['status']) }));

    const agreementParties = (await one('select ap.agreement_id, ap.party_id, ap.role, ap.share_pct, ap.from_date, ap.to_date from agreement_party ap join agreement a on a.id = ap.agreement_id where a.tenant_id = $1')).map((r) => ({ agreementId: String(r['agreement_id']), partyId: String(r['party_id']), role: String(r['role']), sharePct: n(r['share_pct']), from: s(r['from_date']), to: s(r['to_date']) }));

    const pricingRules = (await one('select id, tenant_id, name, base_cents, min_cents, max_cents, weekend_factor_bps, occupancy_tiers, lead_time_tiers, los_discounts, seasons from pricing_rule where tenant_id = $1')).map((r) => ({ id: String(r['id']), tenantId: tid, name: String(r['name']), baseCents: Number(r['base_cents']), minCents: n(r['min_cents']), maxCents: n(r['max_cents']), weekendFactorBps: n(r['weekend_factor_bps']), occupancyTiers: arr(r['occupancy_tiers']), leadTimeTiers: arr(r['lead_time_tiers']), losDiscounts: arr(r['los_discounts']), seasons: arr(r['seasons']) }));
    const purchaseOrders = (await one('select id, tenant_id, vendor_id, entity_id, created_at, expected_at, currency, total_cents, status, billed_cents, approved_at, received_at, closed_at, cancelled_at, memo, lines from purchase_order where tenant_id = $1')).map((r) => ({ id: String(r['id']), tenantId: tid, vendorId: String(r['vendor_id']), entityId: s(r['entity_id']), createdAt: toIso(r['created_at']), expectedAt: r['expected_at'] == null ? undefined : toIso(r['expected_at']), currency: String(r['currency']), totalCents: Number(r['total_cents']), status: String(r['status']), billedCents: Number(r['billed_cents']), approvedAt: r['approved_at'] == null ? undefined : toIso(r['approved_at']), receivedAt: r['received_at'] == null ? undefined : toIso(r['received_at']), closedAt: r['closed_at'] == null ? undefined : toIso(r['closed_at']), cancelledAt: r['cancelled_at'] == null ? undefined : toIso(r['cancelled_at']), memo: s(r['memo']), lines: arr(r['lines']) as Array<{ description: string; account: string; amountCents: number }> }));
    const budgets = (await one('select id, tenant_id, account, period_start, period_end, amount_cents, label from budget where tenant_id = $1')).map((r) => ({ id: String(r['id']), tenantId: tid, account: String(r['account']), periodStart: toDate(r['period_start']), periodEnd: toDate(r['period_end']), amountCents: Number(r['amount_cents']), label: s(r['label']) }));
    const prospects = (await one('select id, tenant_id, name, party_id, preferences from roommate_prospect where tenant_id = $1')).map((r) => ({ id: String(r['id']), tenantId: tid, name: String(r['name']), partyId: s(r['party_id']), preferences: obj(r['preferences']) }));
    const leads = (await one('select id, tenant_id, name, source, stage, est_value_cents, party_id, created_at, updated_at, stage_at, lost_reason from crm_lead where tenant_id = $1')).map((r) => ({ id: String(r['id']), tenantId: tid, name: String(r['name']), source: s(r['source']), stage: String(r['stage']), estValueCents: Number(r['est_value_cents']), partyId: s(r['party_id']), createdAt: toIso(r['created_at']), updatedAt: toIso(r['updated_at']), stageAt: obj(r['stage_at']), lostReason: s(r['lost_reason']) }));
    const applications = (await one('select id, tenant_id, lead_id, unit_id, applicant_name, applicant_email, income_cents, status, submitted_at, screening, decided_at, decided_by, adverse_action_reason from application where tenant_id = $1')).map((r) => ({ id: String(r['id']), tenantId: tid, leadId: s(r['lead_id']), unitId: s(r['unit_id']), applicantName: String(r['applicant_name']), applicantEmail: s(r['applicant_email']), incomeCents: n(r['income_cents']), status: String(r['status']), submittedAt: toIso(r['submitted_at']), screening: r['screening'] == null ? undefined : obj(r['screening']), decidedAt: r['decided_at'] == null ? undefined : toIso(r['decided_at']), decidedBy: s(r['decided_by']), adverseActionReason: s(r['adverse_action_reason']) }));
    const tours = (await one('select id, tenant_id, lead_id, unit_id, prospect_name, prospect_email, scheduled_at, status, agent_id, notes, created_at, completed_at, cancel_reason from tour where tenant_id = $1')).map((r) => ({ id: String(r['id']), tenantId: tid, leadId: s(r['lead_id']), unitId: s(r['unit_id']), prospectName: String(r['prospect_name']), prospectEmail: s(r['prospect_email']), scheduledAt: toIso(r['scheduled_at']), status: String(r['status']), agentId: s(r['agent_id']), notes: s(r['notes']), createdAt: toIso(r['created_at']), completedAt: r['completed_at'] == null ? undefined : toIso(r['completed_at']), cancelReason: s(r['cancel_reason']) }));
    const unitTurns = (await one('select id, tenant_id, unit_id, status, vacated_at, ready_at, tasks, agent_id, notes, created_at, cancel_reason from unit_turn where tenant_id = $1')).map((r) => ({ id: String(r['id']), tenantId: tid, unitId: String(r['unit_id']), status: String(r['status']), vacatedAt: toIso(r['vacated_at']), readyAt: r['ready_at'] == null ? undefined : toIso(r['ready_at']), tasks: arr(r['tasks']) as Array<{ key: string; label: string; done: boolean; doneAt?: string }>, agentId: s(r['agent_id']), notes: s(r['notes']), createdAt: toIso(r['created_at']), cancelReason: s(r['cancel_reason']) }));
    const pmSchedules = (await one('select id, tenant_id, title, space_id, cadence_days, priority, next_due_at, last_run_at, active, created_at from pm_schedule where tenant_id = $1')).map((r) => ({ id: String(r['id']), tenantId: tid, title: String(r['title']), spaceId: s(r['space_id']), cadenceDays: Number(r['cadence_days']), priority: String(r['priority']), nextDueAt: toDate(r['next_due_at']), lastRunAt: r['last_run_at'] == null ? undefined : toIso(r['last_run_at']), active: r['active'] !== false, createdAt: toIso(r['created_at']) }));
    const insurancePolicies = (await one('select id, tenant_id, agreement_id, party_id, carrier, policy_number, liability_cents, effective_at, expires_at, status, verified_at, notes, created_at from insurance_policy where tenant_id = $1')).map((r) => ({ id: String(r['id']), tenantId: tid, agreementId: String(r['agreement_id']), partyId: s(r['party_id']), carrier: String(r['carrier']), policyNumber: String(r['policy_number']), liabilityCents: Number(r['liability_cents']), effectiveAt: toDate(r['effective_at']), expiresAt: toDate(r['expires_at']), status: String(r['status']), verifiedAt: r['verified_at'] == null ? undefined : toIso(r['verified_at']), notes: s(r['notes']), createdAt: toIso(r['created_at']) }));
    const integrations = (await one('select id, tenant_id, kind, provider, status, config, secret_ref, created_at from integration where tenant_id = $1')).map((r) => ({ id: String(r['id']), tenantId: tid, kind: String(r['kind']), provider: String(r['provider']), status: String(r['status']), config: obj(r['config']), secretRef: s(r['secret_ref']), createdAt: toIso(r['created_at']) }));
    const connectorCommands = (await one('select id, tenant_id, integration_id, action, payload, status, created_at, dispatched_at, resolved_at, result from connector_command where tenant_id = $1')).map((r) => ({ id: String(r['id']), tenantId: tid, integrationId: String(r['integration_id']), action: String(r['action']), payload: obj(r['payload']), status: String(r['status']), createdAt: toIso(r['created_at']), dispatchedAt: r['dispatched_at'] == null ? undefined : toIso(r['dispatched_at']), resolvedAt: r['resolved_at'] == null ? undefined : toIso(r['resolved_at']), result: r['result'] == null ? undefined : obj(r['result']) }));
    const signatureEnvelopes = (await one('select id, tenant_id, document_name, provider, provider_ref, lead_id, agreement_id, signers, status, created_at, sent_at, completed_at, void_reason, decline_reason from signature_envelope where tenant_id = $1')).map((r) => ({ id: String(r['id']), tenantId: tid, documentName: String(r['document_name']), provider: String(r['provider']), providerRef: s(r['provider_ref']), leadId: s(r['lead_id']), agreementId: s(r['agreement_id']), signers: arr(r['signers']), status: String(r['status']), createdAt: toIso(r['created_at']), sentAt: r['sent_at'] == null ? undefined : toIso(r['sent_at']), completedAt: r['completed_at'] == null ? undefined : toIso(r['completed_at']), voidReason: s(r['void_reason']), declineReason: s(r['decline_reason']) }));

    const workOrders = (await one('select id, tenant_id, space_id, title, description, category, priority, status, requested_by_party_id, assigned_vendor_party_id, bill_id, opened_at, assigned_at, started_at, closed_at, resolution, cancel_reason from work_order where tenant_id = $1')).map((r) => ({ id: String(r['id']), tenantId: tid, spaceId: s(r['space_id']), title: String(r['title']), description: s(r['description']), category: s(r['category']), priority: String(r['priority']), status: String(r['status']), requestedByPartyId: s(r['requested_by_party_id']), assignedVendorPartyId: s(r['assigned_vendor_party_id']), billId: s(r['bill_id']), openedAt: toIso(r['opened_at']), assignedAt: r['assigned_at'] == null ? undefined : toIso(r['assigned_at']), startedAt: r['started_at'] == null ? undefined : toIso(r['started_at']), closedAt: r['closed_at'] == null ? undefined : toIso(r['closed_at']), resolution: s(r['resolution']), cancelReason: s(r['cancel_reason']) }));
    const notifications = (await one('select id, tenant_id, channel, recipient, kind, data, status, created_at, sent_at, failed_reason, provider_ref from notification where tenant_id = $1')).map((r) => ({ id: String(r['id']), tenantId: tid, channel: String(r['channel']), to: String(r['recipient']), kind: String(r['kind']), data: obj(r['data']), status: String(r['status']), createdAt: toIso(r['created_at']), sentAt: r['sent_at'] == null ? undefined : toIso(r['sent_at']), failedReason: s(r['failed_reason']), providerRef: s(r['provider_ref']) }));
    // Escalations are tenant-scoped through their policy ctx (jsonb tenantId).
    const exceptions = (await one("select id, action, ctx, reason, status, created_at, resolved_at, resolved_by, note from exception_item where ctx->>'tenantId' = $1")).map((r) => ({ id: String(r['id']), action: String(r['action']), ctx: obj(r['ctx']), reason: String(r['reason']), status: String(r['status']), createdAt: toIso(r['created_at']), resolvedAt: r['resolved_at'] == null ? undefined : toIso(r['resolved_at']), resolvedBy: s(r['resolved_by']), note: s(r['note']) }));

    // Tenant-scoped: the action log is a shared append-only stream, so it MUST
    // filter by tenant_id or a cold-start would rehydrate every tenant's audit.
    const actionLog = (await one('select seq, tenant_id, at, actor, action, effect, rule_id, outcome, reason, exception_id from action_log where tenant_id = $1 order by seq')).map((r) => ({ seq: Number(r['seq']), tenantId: tid, at: toIso(r['at']), actor: String(r['actor']), action: String(r['action']), effect: String(r['effect']), ruleId: s(r['rule_id']) ?? null, outcome: String(r['outcome']), reason: String(r['reason']), exceptionId: s(r['exception_id']) ?? null }));

    const periodLocks = (await one('select tenant_id, period, status, closed_at, closed_by, reopened_at, reopened_by from period_lock where tenant_id = $1')).map((r) => ({ tenantId: tid, period: String(r['period']), status: String(r['status']), closedAt: s(r['closed_at']) ? toIso(r['closed_at']) : undefined, closedBy: s(r['closed_by']), reopenedAt: s(r['reopened_at']) ? toIso(r['reopened_at']) : undefined, reopenedBy: s(r['reopened_by']) }));
    const bankAccounts = (await one('select id, tenant_id, code, name, kind, gl_account, entity_id from bank_account where tenant_id = $1')).map((r) => ({ id: String(r['id']), tenantId: tid, code: String(r['code']), name: String(r['name']), kind: String(r['kind']), glAccount: String(r['gl_account']), entityId: s(r['entity_id']) }));
    return { tenants, units, unitTypes, properties, guests, ratePlans, users, customRoles, legalEntities, parties, spaces, chargeTypes, agreements, holds, journalLines, invoices, payments, deposits, bills, apPayments, agreementParties, pricingRules, purchaseOrders, budgets, prospects, leads, applications, tours, unitTurns, pmSchedules, insurancePolicies, integrations, connectorCommands, signatureEnvelopes, workOrders, notifications, exceptions, periodLocks, bankAccounts, actionLog } as unknown as WorldData;
  }

  private async activeHoldsAll(): Promise<CalendarHold[]> {
    const rows = await this.q.query({
      text: `select ch.id, ch.unit_id, ch.holder_id, ch.start_date, ch.end_date, ch.status from calendar_hold ch join unit u on u.id = ch.unit_id where u.tenant_id = $1`,
      values: [this.tenantId],
    });
    return rows.map((r) => ({ id: String(r['id']), unitId: String(r['unit_id']), holderId: String(r['holder_id']), start: toDate(r['start_date']), end: toDate(r['end_date']), status: String(r['status']) as CalendarHold['status'] }));
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
