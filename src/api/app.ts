// The Public API is the only API (invariant 3). Its core is a transport-agnostic
// router: dispatch(request) -> response. src/api/http.ts binds it to node:http.
//
// Every request passes three gates in order:
//   1. Auth      — no valid bearer -> 401.
//   2. RBAC      — the route's required Permission must be in the caller's role
//                  (src/rbac.ts). Missing -> 403. Answers "may this user do this?"
//   3. Policy    — every MUTATION runs through AgentRuntime.execute so
//                  PolicyEnvelope.decide() precedes the effect (invariant 2).
//                  Answers "is this action safe to auto-execute?" allow -> 2xx,
//                  deny -> 403, escalate -> 202. RBAC and policy are orthogonal.
//
// Every resource is tenant-scoped; cross-tenant reads return 404 (existence is
// never leaked). Money is stored in integer minor units of the tenant's
// configured currency; the *Cents field names mean "minor units".

import { Ledger } from '../ledger.ts';
import { Agreement, Calendar, DoubleInventoryError, escalatedRate, type AgreementKind } from '../agreement.ts';
import { PolicyEnvelope } from '../policy-envelope.ts';
import { ExceptionQueue } from '../exception-queue.ts';
import { AgentRuntime, type ToolCallResult } from '../agent-runtime.ts';
import { Billing, type InvoiceLine } from '../billing.ts';
import { Payables, type ApMethod } from '../payables.ts';
import { Payments, type PaymentMethod } from '../payments.ts';
import { Deposits, type Deduction } from '../deposits.ts';
import { PartyDirectory, type PartyKind, type AgreementRole } from '../party.ts';
import { SpaceTree, type SpaceType } from '../space.ts';
import { EntityCatalog, type EntityRole } from '../entity.ts';
import { WorkOrders, type WorkOrderPriority } from '../maintenance.ts';
import { Reservations } from '../reservations.ts';
import { Inspections, type InspectionKind, type InspectionItem } from '../inspection.ts';
import { Communications, type ThreadKind, type MessageDirection } from '../communications.ts';
import { Reconciliation, suggestMatches, type MatchCandidate, type MatchTargetType } from '../reconciliation.ts';
import { Integrations, ConnectorOutbox, type IntegrationKind, type IntegrationStatus } from '../integrations.ts';
import { RevenueManagement, revenueKpis, type PricingRule, type QuoteContext, type OccupancyTier, type LeadTimeTier, type LosDiscount, type SeasonWindow } from '../revenue.ts';
import { Procurement, computeBudgetStatus, type PurchaseOrderLine, type Budget } from '../procurement.ts';
import { RoommateMatcher, type RoommatePreferences, type Chronotype } from '../roommate.ts';
import { parseCsv, suggestMapping, planImport, type ImportTarget, type ColumnMapping } from '../onboarding.ts';
import { Crm, type LeadStage } from '../crm.ts';
import { Signatures } from '../esign.ts';
import { meterSubscription, type SubscriptionPlan } from '../subscription.ts';
import {
  ConfigStore,
  SUPPORTED_LOCALES,
  SUPPORTED_CURRENCIES,
  BUSINESS_STRUCTURES,
  type TenantConfig,
} from '../config.ts';
import { COUNTRY_PROFILES, countryProfile } from '../country.ts';
import { buildEnvironment } from '../environment.ts';
import { RoleRegistry, PERMISSIONS, type Permission } from '../rbac.ts';
import { MasterData } from '../master-data.ts';
import { catalog } from '../i18n.ts';
import type { WorldData } from '../persistence/project.ts';
import type { PersistenceBackend } from '../persistence/edge-client.ts';
import { StaticTokenAuthenticator, type Authenticator, type AuthContext } from './context.ts';

export interface ApiRequest {
  method: string;
  path: string;
  body?: Record<string, unknown>;
  bearer?: string;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

/** High-water mark of what has already been flushed to durable storage for a
 *  tenant, so the next flush sends only newly-appended rows (incremental sync). */
interface FlushMark {
  /** events already persisted, per agreement id */
  events: Record<string, number>;
  /** tenant-scoped journal lines already persisted */
  journalLines: number;
  /** action-log rows already persisted */
  actionLog: number;
  /** invoice ids whose lines are already persisted */
  invoiceLines: string[];
  /** bill ids whose lines are already persisted */
  bills: string[];
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function statusForError(e: unknown): number {
  if (e instanceof HttpError) return e.status;
  if (e instanceof DoubleInventoryError) return 409;
  const name = e instanceof Error ? e.constructor.name : '';
  if (/Error$/.test(name) && name !== 'Error' && name !== 'TypeError' && name !== 'RangeError') {
    return 409; // Ledger/Billing/Payment/Agreement/Config/Rbac/MasterData errors — conflict with state
  }
  return 500;
}

interface Route {
  method: string;
  regex: RegExp;
  keys: string[];
  permission: Permission | null;
  handler: (ctx: AuthContext, params: Record<string, string>, body: Record<string, unknown>) => ApiResponse;
}

function compile(pattern: string): { regex: RegExp; keys: string[] } {
  const keys: string[] = [];
  const regex = new RegExp(
    '^' +
      pattern.replace(/:[A-Za-z]+/g, (m) => {
        keys.push(m.slice(1));
        return '([^/]+)';
      }) +
      '$',
  );
  return { regex, keys };
}

export interface AppConfig {
  authenticator?: Authenticator;
  subscriptionPlan?: SubscriptionPlan;
  /** Shared stores — pass pre-seeded instances (portal), or omit for fresh ones. */
  config?: ConfigStore;
  roles?: RoleRegistry;
  masterData?: MasterData;
  /** Back-compat convenience: seed units as master data. */
  units?: Array<{ id: string; tenantId: string }>;
  now?: () => string;
  /** Durable write arm (persist-world Edge Function). Omit → /persist is 501. */
  persistence?: PersistenceBackend;
}

export class App {
  readonly ledger = new Ledger();
  readonly calendar = new Calendar();
  readonly exceptions = new ExceptionQueue();
  readonly runtime: AgentRuntime;
  readonly billing: Billing;
  readonly payables: Payables;
  readonly payments: Payments;
  readonly deposits: Deposits;
  readonly parties = new PartyDirectory();
  readonly spaces = new SpaceTree();
  readonly entities = new EntityCatalog();
  readonly maintenance = new WorkOrders();
  readonly reservations = new Reservations(this.calendar);
  readonly inspections = new Inspections();
  readonly comms = new Communications();
  readonly reconciliation = new Reconciliation();
  readonly integrations = new Integrations();
  readonly connectorOutbox = new ConnectorOutbox();
  readonly revenue = new RevenueManagement();
  readonly procurement = new Procurement();
  readonly roommates = new RoommateMatcher();
  readonly crm = new Crm();
  readonly signatures = new Signatures();

  readonly config: ConfigStore;
  readonly roles: RoleRegistry;
  readonly masterData: MasterData;

  private readonly auth: Authenticator;
  private readonly plan: SubscriptionPlan;
  private readonly persistence?: PersistenceBackend;
  private readonly now: () => string;
  private readonly agreements = new Map<string, { agreement: Agreement; tenantId: string }>();
  private readonly invoiceTenant = new Map<string, string>();
  private readonly depositTenant = new Map<string, string>();
  private readonly flushMarks = new Map<string, FlushMark>();
  private readonly routes: Route[] = [];

  constructor(config: AppConfig = {}) {
    this.runtime = new AgentRuntime(new PolicyEnvelope(), this.exceptions);
    this.billing = new Billing(this.ledger);
    this.payables = new Payables(this.ledger);
    this.payments = new Payments(this.ledger, this.billing);
    this.deposits = new Deposits(this.ledger);
    this.auth = config.authenticator ?? new StaticTokenAuthenticator();
    this.plan = config.subscriptionPlan ?? { perUnitCents: 5000, currency: 'BRL' };
    this.persistence = config.persistence;
    this.config = config.config ?? new ConfigStore();
    this.roles = config.roles ?? new RoleRegistry();
    this.masterData = config.masterData ?? new MasterData();
    this.now = config.now ?? (() => new Date().toISOString());
    for (const u of config.units ?? []) {
      if (!this.masterData.units.get(u.tenantId, u.id)) {
        this.masterData.units.add({ id: u.id, tenantId: u.tenantId, code: u.id, label: u.id, active: true });
      }
    }
    this.registerRoutes();
  }

  // --- transport-agnostic entry point --------------------------------------
  dispatch(req: ApiRequest): ApiResponse {
    const ctx = this.auth.authenticate(req.bearer);
    if (!ctx) return { status: 401, body: { error: 'unauthenticated' } };

    for (const route of this.routes) {
      if (route.method !== req.method) continue;
      const m = route.regex.exec(req.path);
      if (!m) continue;

      if (route.permission) {
        const perms = this.roles.permissionsFor(ctx.tenantId, ctx.role);
        if (!perms.has(route.permission)) {
          return { status: 403, body: { error: 'forbidden', permission: route.permission } };
        }
      }

      const params: Record<string, string> = {};
      route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)));
      try {
        return route.handler(ctx, params, req.body ?? {});
      } catch (e) {
        return { status: statusForError(e), body: { error: e instanceof Error ? e.message : String(e) } };
      }
    }
    return { status: 404, body: { error: 'not found' } };
  }

  private add(method: string, pattern: string, permission: Permission | null, handler: Route['handler']): void {
    const { regex, keys } = compile(pattern);
    this.routes.push({ method, regex, keys, permission, handler });
  }

  private gated<T>(
    action: string,
    ctx: AuthContext,
    extra: Record<string, unknown>,
    fn: () => T,
    onExecuted: (result: T) => ApiResponse,
  ): ApiResponse {
    const result: ToolCallResult<T> = this.runtime.execute(
      action,
      // The tenant's country jurisdiction rides in the policy context, so a rule
      // may be jurisdiction-scoped (e.g. lease.execute in BR/EU) without any code
      // fork — the master-data structure is identical for every country.
      { actor: ctx.actor, tenantId: ctx.tenantId, jurisdiction: this.config.get(ctx.tenantId).jurisdiction, ...extra },
      this.now(),
      fn,
    );
    if (result.outcome === 'executed') return onExecuted(result.result as T);
    if (result.outcome === 'escalated') {
      return { status: 202, body: { status: 'escalated', exceptionId: result.exceptionId, reason: result.reason } };
    }
    return { status: 403, body: { status: 'denied', reason: result.reason } };
  }

  private requireString(body: Record<string, unknown>, key: string): string {
    const v = body[key];
    if (typeof v !== 'string' || v.length === 0) throw new HttpError(400, `missing or invalid '${key}'`);
    return v;
  }

  private requireInt(body: Record<string, unknown>, key: string): number {
    const v = body[key];
    if (typeof v !== 'number' || !Number.isInteger(v)) throw new HttpError(400, `missing or invalid integer '${key}'`);
    return v;
  }

  private optString(body: Record<string, unknown>, key: string): string | undefined {
    return typeof body[key] === 'string' ? (body[key] as string) : undefined;
  }

  private agreementSummary(a: Agreement) {
    return { id: a.id, kind: a.kind, status: a.status, rateCents: a.rateCents, period: a.period, unitId: a.currentUnitId };
  }

  private ownedAgreement(ctx: AuthContext, id: string): Agreement {
    const entry = this.agreements.get(id);
    if (!entry || entry.tenantId !== ctx.tenantId) throw new HttpError(404, 'agreement not found');
    // A party-scoped token (a guest/resident, not an operator) may only reach an
    // agreement its party is linked to — 404 otherwise so existence is not leaked.
    // Operator tokens carry no partyId and skip this check.
    if (ctx.partyId !== undefined && !this.callerLinkedToAgreement(ctx.partyId, id)) {
      throw new HttpError(404, 'agreement not found');
    }
    return entry.agreement;
  }

  /** Is this party currently a party (any role) on the agreement? */
  private callerLinkedToAgreement(partyId: string, agreementId: string): boolean {
    return this.parties.partiesFor(agreementId).some((l) => l.partyId === partyId);
  }

  private ownedWorkOrder(ctx: AuthContext, id: string) {
    let wo;
    try {
      wo = this.maintenance.get(id);
    } catch {
      throw new HttpError(404, 'work order not found');
    }
    if (wo.tenantId !== ctx.tenantId) throw new HttpError(404, 'work order not found');
    return wo;
  }

  private ownedReservation(ctx: AuthContext, id: string) {
    let r;
    try {
      r = this.reservations.get(id);
    } catch {
      throw new HttpError(404, 'reservation not found');
    }
    if (r.tenantId !== ctx.tenantId) throw new HttpError(404, 'reservation not found');
    return r;
  }

  private ownedInspection(ctx: AuthContext, id: string) {
    let r;
    try {
      r = this.inspections.get(id);
    } catch {
      throw new HttpError(404, 'inspection not found');
    }
    if (r.tenantId !== ctx.tenantId) throw new HttpError(404, 'inspection not found');
    return r;
  }

  private ownedThread(ctx: AuthContext, id: string) {
    let t;
    try {
      t = this.comms.getThread(id);
    } catch {
      throw new HttpError(404, 'thread not found');
    }
    if (t.tenantId !== ctx.tenantId) throw new HttpError(404, 'thread not found');
    return t;
  }

  private ownedBankTxn(ctx: AuthContext, id: string) {
    let t;
    try {
      t = this.reconciliation.get(id);
    } catch {
      throw new HttpError(404, 'bank transaction not found');
    }
    if (t.tenantId !== ctx.tenantId) throw new HttpError(404, 'bank transaction not found');
    return t;
  }

  private ownedIntegration(ctx: AuthContext, id: string) {
    let r;
    try {
      r = this.integrations.get(id);
    } catch {
      throw new HttpError(404, 'integration not found');
    }
    if (r.tenantId !== ctx.tenantId) throw new HttpError(404, 'integration not found');
    return r;
  }

  private ownedPurchaseOrder(ctx: AuthContext, id: string) {
    let po;
    try {
      po = this.procurement.get(id);
    } catch {
      throw new HttpError(404, 'purchase order not found');
    }
    if (po.tenantId !== ctx.tenantId) throw new HttpError(404, 'purchase order not found');
    return po;
  }

  /** Shared parse for the onboarding endpoints: validate target, parse the CSV,
   *  and layer any caller-supplied column mapping over the heuristic suggestion
   *  (the AI-mapping seam — an LLM's mapping wins where provided). */
  private parseOnboarding(body: Record<string, unknown>): { target: ImportTarget; headers: string[]; rows: string[][]; mapping: ColumnMapping } {
    const target = this.requireString(body, 'target') as ImportTarget;
    if (target !== 'units' && target !== 'guests') throw new HttpError(400, "target must be 'units' or 'guests'");
    const csv = this.requireString(body, 'csv');
    const { headers, rows } = parseCsv(csv);
    if (headers.length === 0) throw new HttpError(400, 'csv has no header row');
    const mapping: ColumnMapping = suggestMapping(target, headers);
    const supplied = body['mapping'];
    if (supplied && typeof supplied === 'object') {
      for (const [k, v] of Object.entries(supplied as Record<string, unknown>)) {
        if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < headers.length) mapping[k] = v;
      }
    }
    return { target, headers, rows, mapping };
  }

  private ownedEnvelope(ctx: AuthContext, id: string) {
    let e;
    try {
      e = this.signatures.get(id);
    } catch {
      throw new HttpError(404, 'signature envelope not found');
    }
    if (e.tenantId !== ctx.tenantId) throw new HttpError(404, 'signature envelope not found');
    return e;
  }

  private ownedLead(ctx: AuthContext, id: string) {
    let l;
    try {
      l = this.crm.get(id);
    } catch {
      throw new HttpError(404, 'lead not found');
    }
    if (l.tenantId !== ctx.tenantId) throw new HttpError(404, 'lead not found');
    return l;
  }

  private ownedProspect(ctx: AuthContext, id: string) {
    let p;
    try {
      p = this.roommates.get(id);
    } catch {
      throw new HttpError(404, 'prospect not found');
    }
    if (p.tenantId !== ctx.tenantId) throw new HttpError(404, 'prospect not found');
    return p;
  }

  private ownedCommand(ctx: AuthContext, id: string) {
    let c;
    try {
      c = this.connectorOutbox.get(id);
    } catch {
      throw new HttpError(404, 'command not found');
    }
    if (c.tenantId !== ctx.tenantId) throw new HttpError(404, 'command not found');
    return c;
  }

  /** Ledger money movements a bank line can match against: payments in (+) and
   *  AP payments out (−), scoped to the tenant and signed to the bank convention. */
  private matchCandidates(tenantId: string): MatchCandidate[] {
    const out: MatchCandidate[] = [];
    for (const pm of this.payments.all()) {
      if (this.invoiceTenant.get(pm.invoiceId) === tenantId) {
        out.push({ type: 'payment', id: pm.id, amountCents: pm.amountCents, at: pm.receivedAt });
      }
    }
    for (const ap of this.payables.allPayments()) {
      const bill = this.payables.allBills().find((b) => b.id === ap.billId);
      if (bill && bill.tenantId === tenantId) {
        out.push({ type: 'ap_payment', id: ap.id, amountCents: -ap.amountCents, at: ap.paidAt });
      }
    }
    return out;
  }

  private registerRoutes(): void {
    this.add('GET', '/health', null, () => ({ status: 200, body: { ok: true } }));

    // --- session / config --------------------------------------------------
    // Who am I + my permissions — the first call the portal makes.
    this.add('GET', '/me', null, (ctx) => ({
      status: 200,
      body: {
        actor: ctx.actor,
        tenantId: ctx.tenantId,
        role: ctx.role,
        permissions: [...this.roles.permissionsFor(ctx.tenantId, ctx.role)],
      },
    }));

    this.add('GET', '/config', 'config.read', (ctx) => ({
      status: 200,
      body: {
        config: this.config.get(ctx.tenantId),
        options: {
          locales: SUPPORTED_LOCALES,
          currencies: SUPPORTED_CURRENCIES,
          businessStructures: BUSINESS_STRUCTURES,
          countries: COUNTRY_PROFILES,
        },
      },
    }));

    // The country environments this deployment can serve. Same master-data
    // structure everywhere; only config + jurisdiction differ per country.
    this.add('GET', '/countries', null, () => ({ status: 200, body: { countries: COUNTRY_PROFILES } }));

    // This tenant's country environment: its config, jurisdiction, the effective
    // (jurisdiction-scoped) policy, and the IDENTICAL master-data structure. This
    // is the per-country setup made inspectable — proof that a country changes
    // configuration + policy, never the shape of the data.
    this.add('GET', '/environment', 'config.read', (ctx) => {
      const cfg = this.config.get(ctx.tenantId);
      return { status: 200, body: buildEnvironment(cfg.country, { currency: cfg.currency, locale: cfg.locale, timezone: cfg.timezone, businessStructure: cfg.businessStructure }) };
    });

    // Setup-time: change country, language, currency, timezone, business
    // structure. Setting a country re-derives the jurisdiction (never set alone)
    // and, when currency/locale/timezone are omitted, seeds them from the
    // country profile — but the master-data structure is identical for all.
    this.add('PUT', '/config', 'config.manage', (ctx, _p, body) => {
      const country = this.optString(body, 'country');
      if (country !== undefined) {
        const overrides: Partial<Omit<TenantConfig, 'tenantId' | 'displayName' | 'country' | 'jurisdiction'>> = {};
        for (const k of ['locale', 'currency', 'timezone', 'businessStructure'] as const) {
          const v = this.optString(body, k);
          if (v !== undefined) overrides[k] = v;
        }
        const displayName = this.optString(body, 'displayName') ?? this.config.get(ctx.tenantId).displayName;
        // Changing an ALREADY-ESTABLISHED jurisdiction (not first-time setup) can
        // weaken a jurisdiction-scoped control, so it escalates to a human and is
        // audited in the action_log. countryProfile() derives the target jurisdiction.
        // A tenant that has never been explicitly configured is being set up, not
        // changed, so it applies directly.
        const established = this.config.has(ctx.tenantId);
        const current = this.config.get(ctx.tenantId).jurisdiction;
        const next = countryProfile(country).jurisdiction;
        const apply = () => this.config.setupForCountry(ctx.tenantId, displayName, country, overrides);
        if (established && next !== current) {
          return this.gated('config.change_jurisdiction', ctx, { from: current, to: next }, apply, (cfg) => ({ status: 200, body: cfg }));
        }
        return { status: 200, body: apply() };
      }
      const patch: Partial<Omit<TenantConfig, 'tenantId'>> = {};
      for (const k of ['displayName', 'locale', 'currency', 'timezone', 'businessStructure'] as const) {
        const v = this.optString(body, k);
        if (v !== undefined) patch[k] = v;
      }
      return { status: 200, body: this.config.update(ctx.tenantId, patch) };
    });

    this.add('GET', '/i18n/:locale', null, (_ctx, p) => ({ status: 200, body: catalog(p['locale']!) }));

    // --- roles & users (access profiling) ---------------------------------
    this.add('GET', '/permissions', 'role.read', () => ({ status: 200, body: { permissions: PERMISSIONS } }));

    this.add('GET', '/roles', 'role.read', (ctx) => ({
      status: 200,
      body: {
        roles: this.roles.listRoles(ctx.tenantId).map((r) => ({
          id: r.id,
          name: r.name,
          builtin: r.builtin,
          description: r.description,
          permissions: r.permissions === '*' ? [...PERMISSIONS] : r.permissions,
        })),
      },
    }));

    this.add('POST', '/roles', 'role.manage', (ctx, _p, body) => {
      const id = this.requireString(body, 'id');
      const name = this.requireString(body, 'name');
      const perms = Array.isArray(body['permissions']) ? (body['permissions'] as Permission[]) : [];
      const role = this.roles.defineRole(ctx.tenantId, { id, name, permissions: perms, description: this.optString(body, 'description') });
      return { status: 201, body: role };
    });

    this.add('GET', '/users', 'user.read', (ctx) => ({ status: 200, body: { users: this.masterData.users.list(ctx.tenantId) } }));

    this.add('POST', '/users', 'user.manage', (ctx, _p, body) => {
      const roleId = this.requireString(body, 'roleId');
      if (!this.roles.resolve(ctx.tenantId, roleId)) throw new HttpError(400, `unknown role: ${roleId}`);
      const user = this.masterData.users.add({
        id: this.requireString(body, 'id'),
        tenantId: ctx.tenantId,
        code: this.requireString(body, 'code'),
        displayName: this.requireString(body, 'displayName'),
        roleId,
        active: body['active'] !== false,
      });
      return { status: 201, body: user };
    });

    // --- master data (reporting + API connectivity anchors) ---------------
    this.add('GET', '/master-data', 'masterdata.read', (ctx) => ({ status: 200, body: this.masterData.snapshot(ctx.tenantId) }));

    this.add('POST', '/units', 'masterdata.manage', (ctx, _p, body) => ({
      status: 201,
      body: this.masterData.units.add({
        id: this.requireString(body, 'id'),
        tenantId: ctx.tenantId,
        code: this.requireString(body, 'code'),
        label: this.requireString(body, 'label'),
        active: body['active'] !== false,
      }),
    }));

    this.add('POST', '/guests', 'masterdata.manage', (ctx, _p, body) => ({
      status: 201,
      body: this.masterData.guests.add({
        id: this.requireString(body, 'id'),
        tenantId: ctx.tenantId,
        code: this.requireString(body, 'code'),
        fullName: this.requireString(body, 'fullName'),
        email: this.optString(body, 'email'),
      }),
    }));

    this.add('POST', '/rate-plans', 'masterdata.manage', (ctx, _p, body) => ({
      status: 201,
      body: this.masterData.ratePlans.add({
        id: this.requireString(body, 'id'),
        tenantId: ctx.tenantId,
        code: this.requireString(body, 'code'),
        name: this.requireString(body, 'name'),
        kind: this.requireString(body, 'kind') as 'nightly' | 'monthly' | 'lease',
        baseMinor: this.requireInt(body, 'baseMinor'),
      }),
    }));

    // --- agreements --------------------------------------------------------
    this.add('POST', '/agreements', 'agreement.book', (ctx, _p, body) => {
      const id = this.requireString(body, 'id');
      const unitId = this.requireString(body, 'unitId');
      if (this.tenantHasUnits(ctx.tenantId) && !this.masterData.units.get(ctx.tenantId, unitId)) {
        throw new HttpError(404, 'unit not found for tenant');
      }
      const guestId = this.requireString(body, 'guestId');
      const kind = this.requireString(body, 'kind') as AgreementKind;
      const start = this.requireString(body, 'start');
      const end = this.requireString(body, 'end');
      const rateCents = this.requireInt(body, 'rateCents');
      const at = this.optString(body, 'at') ?? this.now();
      const currency = this.optString(body, 'currency') ?? this.config.get(ctx.tenantId).currency;
      if (this.agreements.has(id)) throw new HttpError(409, `agreement ${id} already exists`);

      return this.gated(
        'agreement.create',
        ctx,
        { unitId },
        () => {
          const a = Agreement.create({ id, tenantId: ctx.tenantId, guestId, unitId, kind, start, end, rateCents, currency, at });
          this.calendar.hold({ id: `${id}-hold`, unitId, holderId: id, start, end }); // invariant 4
          this.agreements.set(id, { agreement: a, tenantId: ctx.tenantId });
          return a;
        },
        (a) => ({ status: 201, body: this.agreementSummary(a) }),
      );
    });

    this.add('POST', '/agreements/:id/activate', 'agreement.activate', (ctx, p, body) => {
      const a = this.ownedAgreement(ctx, p['id']!);
      const at = this.optString(body, 'at') ?? this.now();
      return this.gated('agreement.activate', ctx, {}, () => a.activate(at), () => ({ status: 200, body: this.agreementSummary(a) }));
    });

    this.add('POST', '/agreements/:id/convert', 'agreement.convert', (ctx, p, body) => {
      const a = this.ownedAgreement(ctx, p['id']!);
      const to = this.requireString(body, 'to') as AgreementKind;
      const at = this.optString(body, 'at') ?? this.now();
      const opts: { rateCents?: number; end?: string } = {};
      if (typeof body['rateCents'] === 'number') opts.rateCents = body['rateCents'] as number;
      if (typeof body['end'] === 'string') opts.end = body['end'] as string;
      return this.gated('agreement.convert', ctx, { to }, () => a.convert(to, at, opts), () => ({ status: 200, body: this.agreementSummary(a) }));
    });

    this.add('GET', '/agreements', 'agreement.read', (ctx) => ({
      status: 200,
      body: {
        agreements: [...this.agreements.values()]
          .filter((e) => e.tenantId === ctx.tenantId)
          // A party-scoped token sees only its own agreements, not the whole tenant.
          .filter((e) => ctx.partyId === undefined || this.callerLinkedToAgreement(ctx.partyId, e.agreement.id))
          .map((e) => this.agreementSummary(e.agreement)),
      },
    }));

    this.add('GET', '/agreements/:id', 'agreement.read', (ctx, p) => {
      const a = this.ownedAgreement(ctx, p['id']!);
      return { status: 200, body: { ...this.agreementSummary(a), history: a.history } };
    });

    // Billing rollup for one agreement: invoices + their payments + deposits.
    this.add('GET', '/agreements/:id/billing', 'invoice.read', (ctx, p) => {
      const agId = p['id']!;
      this.ownedAgreement(ctx, agId); // 404 if not this tenant's
      const invoices = this.billing.allInvoices().filter((i) => i.agreementId === agId);
      const invoiceIds = new Set(invoices.map((i) => i.id));
      const payments = this.payments.all().filter((pm) => invoiceIds.has(pm.invoiceId));
      const deposits = this.deposits.all().filter((d) => d.agreementId === agId);
      return { status: 200, body: { invoices, payments, deposits } };
    });

    // --- invoices ----------------------------------------------------------
    this.add('POST', '/invoices', 'invoice.issue', (ctx, _p, body) => {
      const id = this.requireString(body, 'id');
      const agreementId = this.requireString(body, 'agreementId');
      this.ownedAgreement(ctx, agreementId);
      const dueAt = this.requireString(body, 'dueAt');
      const issuedAt = this.optString(body, 'issuedAt') ?? this.now();
      const currency = this.config.get(ctx.tenantId).currency;
      const rawLines = Array.isArray(body['lines']) ? (body['lines'] as unknown[]) : [];
      // A line may name a charge code, which routes it to a GL account + a
      // receiving entity (charge catalog). All charge-routed lines on one invoice
      // must share the same receiving entity — one invoice, one entity (#11).
      let receivingEntityId: string | undefined;
      const lines: InvoiceLine[] = rawLines.map((l) => {
        const o = l as Record<string, unknown>;
        const chargeCode = this.optString(o, 'chargeCode');
        let account = String(o['account'] ?? '');
        let chargeType: string | undefined;
        if (chargeCode) {
          const r = this.entities.resolve(ctx.tenantId, chargeCode); // EntityError → 409
          account = r.glAccount;
          chargeType = chargeCode;
          if (receivingEntityId && receivingEntityId !== r.receivingEntityId) {
            throw new HttpError(400, 'invoice lines route to different receiving entities; issue one invoice per entity');
          }
          receivingEntityId = r.receivingEntityId;
        }
        return { description: String(o['description'] ?? ''), account, amountCents: Number(o['amountCents']), ...(chargeType ? { chargeType } : {}) };
      });
      const billToPartyId = this.parties.billTo(agreementId) ?? undefined;
      return this.gated(
        'invoice.issue',
        ctx,
        { agreementId },
        () => {
          const inv = this.billing.issue({ id, agreementId, tenantId: ctx.tenantId, issuedAt, dueAt, currency, lines, receivingEntityId, billToPartyId });
          this.invoiceTenant.set(id, ctx.tenantId);
          return inv;
        },
        (inv) => ({ status: 201, body: inv }),
      );
    });

    this.add('GET', '/invoices/:id', 'invoice.read', (ctx, p) => {
      if (this.invoiceTenant.get(p['id']!) !== ctx.tenantId) throw new HttpError(404, 'invoice not found');
      const inv = this.billing.get(p['id']!);
      // A party-scoped token may only read invoices on its own agreements.
      if (ctx.partyId !== undefined && !this.callerLinkedToAgreement(ctx.partyId, inv.agreementId)) {
        throw new HttpError(404, 'invoice not found');
      }
      return { status: 200, body: inv };
    });

    // --- payments ----------------------------------------------------------
    this.add('POST', '/payments', 'payment.record', (ctx, _p, body) => {
      const id = this.requireString(body, 'id');
      const invoiceId = this.requireString(body, 'invoiceId');
      if (this.invoiceTenant.get(invoiceId) !== ctx.tenantId) throw new HttpError(404, 'invoice not found');
      const amountCents = this.requireInt(body, 'amountCents');
      const method = this.requireString(body, 'method') as PaymentMethod;
      const receivedAt = this.optString(body, 'receivedAt') ?? this.now();
      return this.gated(
        'payment.record',
        ctx,
        { amountCents, invoiceId },
        () => this.payments.record({ id, invoiceId, amountCents, method, receivedAt }),
        (pay) => ({ status: 201, body: pay }),
      );
    });

    // --- deposits ----------------------------------------------------------
    this.add('POST', '/deposits', 'deposit.hold', (ctx, _p, body) => {
      const id = this.requireString(body, 'id');
      const agreementId = this.requireString(body, 'agreementId');
      this.ownedAgreement(ctx, agreementId);
      const amountCents = this.requireInt(body, 'amountCents');
      const heldAt = this.optString(body, 'heldAt') ?? this.now();
      const currency = this.config.get(ctx.tenantId).currency;
      return this.gated(
        'deposit.hold',
        ctx,
        { agreementId, amountCents },
        () => {
          const d = this.deposits.hold({ id, agreementId, amountCents, currency, heldAt });
          this.depositTenant.set(id, ctx.tenantId);
          return d;
        },
        (d) => ({ status: 201, body: d }),
      );
    });

    this.add('POST', '/deposits/:id/refund', 'deposit.refund', (ctx, p, body) => {
      const id = p['id']!;
      if (this.depositTenant.get(id) !== ctx.tenantId) throw new HttpError(404, 'deposit not found');
      const at = this.optString(body, 'at') ?? this.now();
      const rawDeductions = Array.isArray(body['deductions']) ? (body['deductions'] as unknown[]) : [];
      const deductions: Deduction[] = rawDeductions.map((d) => {
        const o = d as Record<string, unknown>;
        return { reason: String(o['reason'] ?? ''), amountCents: Number(o['amountCents']) };
      });
      // Thread the NET refund (held − deductions) into the policy context so a
      // large money-out refund escalates like bill.pay (pol-deposit-refund-large).
      const deducted = deductions.reduce((s, d) => s + d.amountCents, 0);
      const refundCents = Math.max(0, this.deposits.get(id).amountCents - deducted);
      return this.gated('deposit.refund', ctx, { depositId: id, amountCents: refundCents }, () => this.deposits.refund(id, at, deductions), (d) => ({ status: 200, body: d }));
    });

    // --- parties (person/org, related to agreements by role) --------------
    this.add('POST', '/parties', 'party.manage', (ctx, _p, body) => ({
      status: 201,
      body: this.parties.addParty({
        id: this.requireString(body, 'id'),
        tenantId: ctx.tenantId,
        kind: this.requireString(body, 'kind') as PartyKind,
        displayName: this.requireString(body, 'displayName'),
        legalName: this.optString(body, 'legalName'),
        taxId: this.optString(body, 'taxId'),
        email: this.optString(body, 'email'),
        phone: this.optString(body, 'phone'),
        attributes: body['attributes'] && typeof body['attributes'] === 'object' ? (body['attributes'] as Record<string, unknown>) : undefined,
      }),
    }));

    this.add('GET', '/parties', 'party.read', (ctx) => ({ status: 200, body: { parties: this.parties.listParties(ctx.tenantId) } }));

    // Attach a party to an agreement in a role (resident, payer, guarantor …).
    this.add('POST', '/agreements/:id/parties', 'party.manage', (ctx, p, body) => {
      const agId = p['id']!;
      this.ownedAgreement(ctx, agId);
      const partyId = this.requireString(body, 'partyId');
      if (!this.parties.getParty(ctx.tenantId, partyId)) throw new HttpError(404, 'party not found');
      const link = this.parties.assign({
        agreementId: agId,
        partyId,
        role: this.requireString(body, 'role') as AgreementRole,
        sharePct: typeof body['sharePct'] === 'number' ? (body['sharePct'] as number) : undefined,
        from: this.optString(body, 'from'),
      });
      return { status: 201, body: link };
    });

    this.add('GET', '/agreements/:id/parties', 'agreement.read', (ctx, p) => {
      const agId = p['id']!;
      this.ownedAgreement(ctx, agId);
      return { status: 200, body: { parties: this.parties.partiesFor(agId), billToPartyId: this.parties.billTo(agId) } };
    });

    // --- spaces (property → building → unit → room → bed, + common/amenity) --
    this.add('POST', '/spaces', 'space.manage', (ctx, _p, body) => ({
      status: 201,
      body: this.spaces.add({
        id: this.requireString(body, 'id'),
        tenantId: ctx.tenantId,
        parentId: this.optString(body, 'parentId'),
        type: this.requireString(body, 'type') as SpaceType,
        code: this.requireString(body, 'code'),
        label: this.requireString(body, 'label'),
        leasable: body['leasable'] === true,
        capacity: typeof body['capacity'] === 'number' ? (body['capacity'] as number) : undefined,
      }),
    }));

    this.add('GET', '/spaces', 'space.read', (ctx) => ({ status: 200, body: { spaces: this.spaces.list(ctx.tenantId) } }));

    // --- legal entities + charge catalog (money routing, #11) -------------
    this.add('POST', '/legal-entities', 'entity.manage', (ctx, _p, body) => ({
      status: 201,
      body: this.entities.addEntity({
        id: this.requireString(body, 'id'),
        tenantId: ctx.tenantId,
        role: this.requireString(body, 'role') as EntityRole,
        name: this.requireString(body, 'name'),
        taxId: this.optString(body, 'taxId'),
      }),
    }));

    this.add('GET', '/legal-entities', 'entity.read', (ctx) => ({ status: 200, body: { entities: this.entities.listEntities(ctx.tenantId) } }));

    this.add('POST', '/charge-types', 'entity.manage', (ctx, _p, body) => ({
      status: 201,
      body: this.entities.addChargeType({
        id: this.requireString(body, 'id'),
        tenantId: ctx.tenantId,
        code: this.requireString(body, 'code'),
        name: this.requireString(body, 'name'),
        receivingEntityId: this.requireString(body, 'receivingEntityId'),
        glAccount: this.requireString(body, 'glAccount'),
        recurring: body['recurring'] === true,
      }),
    }));

    this.add('GET', '/charge-types', 'entity.read', (ctx) => ({ status: 200, body: { chargeTypes: this.entities.listChargeTypes(ctx.tenantId) } }));

    // --- lease escalation (#8) & unit transfer (#23) ----------------------
    this.add('POST', '/agreements/:id/adjust-rent', 'agreement.adjust', (ctx, p, body) => {
      const a = this.ownedAgreement(ctx, p['id']!);
      const at = this.optString(body, 'at') ?? this.now();
      const basis = this.optString(body, 'basis') as 'percent' | 'fixed' | 'manual' | undefined;
      let rateCents: number;
      if (typeof body['rateCents'] === 'number') {
        rateCents = body['rateCents'] as number;
      } else if (basis === 'percent' || basis === 'fixed') {
        rateCents = escalatedRate(a.rateCents, {
          mode: basis,
          value: this.requireInt(body, 'value'),
          capCents: typeof body['capCents'] === 'number' ? (body['capCents'] as number) : undefined,
        });
      } else {
        throw new HttpError(400, "provide 'rateCents', or 'basis' (percent|fixed) with 'value'");
      }
      return this.gated(
        'agreement.adjust_rent',
        ctx,
        { fromCents: a.rateCents, toCents: rateCents },
        () => {
          a.adjustRent(at, { rateCents, basis: basis ?? 'manual', reason: this.optString(body, 'reason') });
          return a;
        },
        (ag) => ({ status: 200, body: this.agreementSummary(ag) }),
      );
    });

    this.add('POST', '/agreements/:id/transfer', 'agreement.transfer', (ctx, p, body) => {
      const a = this.ownedAgreement(ctx, p['id']!);
      const toUnitId = this.requireString(body, 'toUnitId');
      const known = this.masterData.units.get(ctx.tenantId, toUnitId) || this.spaces.get(ctx.tenantId, toUnitId);
      if (this.tenantHasUnits(ctx.tenantId) && !known) throw new HttpError(404, 'transfer target unit/space not found');
      const at = this.optString(body, 'at') ?? this.now();
      const opts: { rateCents?: number; reason?: string } = {};
      if (typeof body['rateCents'] === 'number') opts.rateCents = body['rateCents'] as number;
      const reason = this.optString(body, 'reason');
      if (reason) opts.reason = reason;
      return this.gated(
        'agreement.transfer',
        ctx,
        { toUnitId },
        () => {
          a.transfer(toUnitId, at, opts);
          // Move the calendar hold to the target space for the remaining period.
          for (const h of this.calendar.activeHolds()) {
            if (h.holderId === a.id) this.calendar.release(h.id);
          }
          const { start, end } = a.period;
          this.calendar.hold({ id: `${a.id}-hold-${a.history.length}`, unitId: toUnitId, holderId: a.id, start, end });
          return a;
        },
        (ag) => ({ status: 200, body: this.agreementSummary(ag) }),
      );
    });

    // --- accounts payable (bills + AP payments; refund = vendor payment) ---
    this.add('POST', '/bills', 'bill.issue', (ctx, _p, body) => {
      const id = this.requireString(body, 'id');
      const payeeId = this.requireString(body, 'payeeId');
      if (!this.parties.getParty(ctx.tenantId, payeeId)) throw new HttpError(404, 'payee party not found');
      const entityId = this.optString(body, 'entityId');
      if (entityId && !this.entities.getEntity(ctx.tenantId, entityId)) throw new HttpError(404, 'entity not found');
      const dueAt = this.requireString(body, 'dueAt');
      const issuedAt = this.optString(body, 'issuedAt') ?? this.now();
      const currency = this.config.get(ctx.tenantId).currency;
      const rawLines = Array.isArray(body['lines']) ? (body['lines'] as unknown[]) : [];
      const lines = rawLines.map((l) => {
        const o = l as Record<string, unknown>;
        return { description: String(o['description'] ?? ''), account: String(o['account'] ?? ''), amountCents: Number(o['amountCents']) };
      });
      // Optionally fulfil a purchase order: the bill's total is recorded against
      // the PO's commitment (auto-closing it when fully billed).
      const poId = this.optString(body, 'poId');
      if (poId) this.ownedPurchaseOrder(ctx, poId); // 404 if not this tenant's PO
      return this.gated(
        'bill.issue',
        ctx,
        { payeeId },
        () => {
          const bill = this.payables.issue({ id, tenantId: ctx.tenantId, payeeId, entityId, issuedAt, dueAt, currency, lines, memo: this.optString(body, 'memo') });
          if (poId) this.procurement.recordBilling(poId, bill.totalCents, issuedAt);
          return bill;
        },
        (bill) => ({ status: 201, body: bill }),
      );
    });

    this.add('POST', '/bills/:id/pay', 'bill.pay', (ctx, p, body) => {
      const billId = p['id']!;
      let bill;
      try {
        bill = this.payables.get(billId);
      } catch {
        throw new HttpError(404, 'bill not found');
      }
      if (bill.tenantId !== ctx.tenantId) throw new HttpError(404, 'bill not found');
      const amountCents = this.requireInt(body, 'amountCents');
      const method = this.requireString(body, 'method') as ApMethod;
      const paidAt = this.optString(body, 'paidAt') ?? this.now();
      const payId = this.requireString(body, 'id');
      return this.gated(
        'bill.pay',
        ctx,
        { amountCents, billId },
        () => this.payables.pay({ id: payId, billId, amountCents, method, paidAt }),
        (pay) => ({ status: 201, body: pay }),
      );
    });

    this.add('GET', '/bills', 'bill.read', (ctx) => ({
      status: 200,
      body: { bills: this.payables.allBills().filter((b) => b.tenantId === ctx.tenantId) },
    }));

    // --- maintenance / work orders (#3) -----------------------------------
    this.add('POST', '/work-orders', 'maintenance.manage', (ctx, _p, body) => {
      const id = this.requireString(body, 'id');
      const title = this.requireString(body, 'title');
      const spaceId = this.optString(body, 'spaceId');
      if (spaceId && !this.spaces.get(ctx.tenantId, spaceId)) throw new HttpError(404, 'space not found');
      const openedAt = this.optString(body, 'openedAt') ?? this.now();
      return this.gated(
        'work_order.open',
        ctx,
        { spaceId },
        () => this.maintenance.open({
          id, tenantId: ctx.tenantId, title, spaceId,
          description: this.optString(body, 'description'),
          category: this.optString(body, 'category'),
          priority: this.optString(body, 'priority') as WorkOrderPriority | undefined,
          requestedByPartyId: this.optString(body, 'requestedByPartyId'),
          openedAt,
        }),
        (wo) => ({ status: 201, body: wo }),
      );
    });

    this.add('GET', '/work-orders', 'maintenance.read', (ctx, _p, _b) => ({
      status: 200,
      body: { workOrders: this.maintenance.list(ctx.tenantId) },
    }));

    this.add('GET', '/work-orders/:id', 'maintenance.read', (ctx, p) => {
      const wo = this.ownedWorkOrder(ctx, p['id']!);
      return { status: 200, body: wo };
    });

    this.add('POST', '/work-orders/:id/assign', 'maintenance.manage', (ctx, p, body) => {
      const id = this.ownedWorkOrder(ctx, p['id']!).id;
      const vendorPartyId = this.requireString(body, 'vendorPartyId');
      if (!this.parties.getParty(ctx.tenantId, vendorPartyId)) throw new HttpError(404, 'vendor party not found');
      const at = this.optString(body, 'at') ?? this.now();
      return this.gated('work_order.update', ctx, { id }, () => this.maintenance.assign(id, vendorPartyId, at), (wo) => ({ status: 200, body: wo }));
    });

    this.add('POST', '/work-orders/:id/start', 'maintenance.manage', (ctx, p, body) => {
      const id = this.ownedWorkOrder(ctx, p['id']!).id;
      const at = this.optString(body, 'at') ?? this.now();
      return this.gated('work_order.update', ctx, { id }, () => this.maintenance.start(id, at), (wo) => ({ status: 200, body: wo }));
    });

    this.add('POST', '/work-orders/:id/complete', 'maintenance.manage', (ctx, p, body) => {
      const id = this.ownedWorkOrder(ctx, p['id']!).id;
      const at = this.optString(body, 'at') ?? this.now();
      const billId = this.optString(body, 'billId');
      if (billId) {
        let bill;
        try { bill = this.payables.get(billId); } catch { throw new HttpError(404, 'bill not found'); }
        if (bill.tenantId !== ctx.tenantId) throw new HttpError(404, 'bill not found');
      }
      return this.gated('work_order.close', ctx, { id }, () => this.maintenance.complete(id, at, { resolution: this.optString(body, 'resolution'), billId }), (wo) => ({ status: 200, body: wo }));
    });

    this.add('POST', '/work-orders/:id/cancel', 'maintenance.manage', (ctx, p, body) => {
      const id = this.ownedWorkOrder(ctx, p['id']!).id;
      const at = this.optString(body, 'at') ?? this.now();
      const reason = this.requireString(body, 'reason');
      return this.gated('work_order.close', ctx, { id }, () => this.maintenance.cancel(id, at, reason), (wo) => ({ status: 200, body: wo }));
    });

    // --- communications (#4) ----------------------------------------------
    this.add('POST', '/threads', 'comms.manage', (ctx, _p, body) => {
      const id = this.requireString(body, 'id');
      const agreementId = this.optString(body, 'agreementId');
      if (agreementId) this.ownedAgreement(ctx, agreementId);
      const partyId = this.optString(body, 'partyId');
      if (partyId && !this.parties.getParty(ctx.tenantId, partyId)) throw new HttpError(404, 'party not found');
      return this.gated(
        'comms.open',
        ctx,
        { agreementId },
        () => this.comms.openThread({ id, tenantId: ctx.tenantId, subject: this.requireString(body, 'subject'), kind: this.requireString(body, 'kind') as ThreadKind, agreementId, partyId, createdAt: this.now() }),
        (th) => ({ status: 201, body: th }),
      );
    });

    this.add('POST', '/threads/:id/messages', 'comms.send', (ctx, p, body) => {
      const thread = this.ownedThread(ctx, p['id']!);
      const id = this.requireString(body, 'id');
      const body_ = this.requireString(body, 'body');
      // An agent sending on the resident's behalf is recorded as authorType=agent.
      const authorType = (this.optString(body, 'authorType') as 'party' | 'user' | 'agent' | undefined) ?? (ctx.role === 'agent' ? 'agent' : 'user');
      const direction = this.optString(body, 'direction') as MessageDirection | undefined;
      return this.gated(
        'comms.send',
        ctx,
        { threadId: thread.id, kind: thread.kind },
        () => this.comms.post({ id, threadId: thread.id, at: this.now(), authorType, authorId: ctx.actor, body: body_, direction }),
        (m) => ({ status: 201, body: m }),
      );
    });

    this.add('POST', '/threads/:id/resolve', 'comms.manage', (ctx, p, _b) => {
      const thread = this.ownedThread(ctx, p['id']!);
      return this.gated('comms.resolve', ctx, { threadId: thread.id }, () => this.comms.resolve(thread.id, this.now()), (th) => ({ status: 200, body: th }));
    });

    this.add('POST', '/threads/:id/reopen', 'comms.manage', (ctx, p, _b) => {
      const thread = this.ownedThread(ctx, p['id']!);
      return this.gated('comms.resolve', ctx, { threadId: thread.id }, () => this.comms.reopen(thread.id), (th) => ({ status: 200, body: th }));
    });

    this.add('GET', '/threads', 'comms.read', (ctx) => ({ status: 200, body: { threads: this.comms.listThreads(ctx.tenantId) } }));
    this.add('GET', '/threads/:id', 'comms.read', (ctx, p) => {
      const thread = this.ownedThread(ctx, p['id']!);
      return { status: 200, body: { thread, messages: this.comms.messagesFor(thread.id) } };
    });

    // --- move-in / move-out + inspections (#18/#19) -----------------------
    this.add('POST', '/agreements/:id/move-in', 'agreement.move', (ctx, p, body) => {
      const a = this.ownedAgreement(ctx, p['id']!);
      const at = this.optString(body, 'at') ?? this.now();
      return this.gated('agreement.move', ctx, { id: a.id }, () => { a.moveIn(at, { inspectionId: this.optString(body, 'inspectionId'), note: this.optString(body, 'note') }); return a; }, (ag) => ({ status: 200, body: this.agreementSummary(ag) }));
    });

    this.add('POST', '/agreements/:id/move-out', 'agreement.move', (ctx, p, body) => {
      const a = this.ownedAgreement(ctx, p['id']!);
      const at = this.optString(body, 'at') ?? this.now();
      return this.gated('agreement.move', ctx, { id: a.id }, () => { a.moveOut(at, { inspectionId: this.optString(body, 'inspectionId'), note: this.optString(body, 'note') }); return a; }, (ag) => ({ status: 200, body: this.agreementSummary(ag) }));
    });

    this.add('POST', '/inspections', 'inspection.manage', (ctx, _p, body) => {
      const id = this.requireString(body, 'id');
      const agreementId = this.requireString(body, 'agreementId');
      this.ownedAgreement(ctx, agreementId);
      const spaceId = this.optString(body, 'spaceId');
      if (spaceId && !this.spaces.get(ctx.tenantId, spaceId)) throw new HttpError(404, 'space not found');
      const kind = this.requireString(body, 'kind') as InspectionKind;
      return this.gated(
        'inspection.create',
        ctx,
        { agreementId },
        () => this.inspections.schedule({ id, tenantId: ctx.tenantId, agreementId, kind, spaceId, scheduledAt: this.optString(body, 'scheduledAt'), createdAt: this.now() }),
        (r) => ({ status: 201, body: r }),
      );
    });

    this.add('POST', '/inspections/:id/complete', 'inspection.manage', (ctx, p, body) => {
      const id = this.ownedInspection(ctx, p['id']!).id;
      const at = this.optString(body, 'at') ?? this.now();
      const rawItems = Array.isArray(body['items']) ? (body['items'] as unknown[]) : [];
      const items: InspectionItem[] = rawItems.map((it) => {
        const o = it as Record<string, unknown>;
        return { area: String(o['area'] ?? ''), condition: String(o['condition'] ?? 'ok') as InspectionItem['condition'], note: this.optString(o, 'note') };
      });
      const damageCents = typeof body['damageCents'] === 'number' ? (body['damageCents'] as number) : undefined;
      return this.gated('inspection.complete', ctx, { id }, () => this.inspections.complete(id, at, { items, damageCents, conductedByPartyId: this.optString(body, 'conductedByPartyId') }), (r) => ({ status: 200, body: r }));
    });

    this.add('POST', '/inspections/:id/cancel', 'inspection.manage', (ctx, p, body) => {
      const id = this.ownedInspection(ctx, p['id']!).id;
      const at = this.optString(body, 'at') ?? this.now();
      return this.gated('inspection.cancel', ctx, { id }, () => this.inspections.cancel(id, at), (r) => ({ status: 200, body: r }));
    });

    this.add('GET', '/inspections', 'inspection.read', (ctx) => ({ status: 200, body: { inspections: this.inspections.list(ctx.tenantId) } }));
    this.add('GET', '/inspections/:id', 'inspection.read', (ctx, p) => ({ status: 200, body: this.ownedInspection(ctx, p['id']!) }));
    this.add('GET', '/agreements/:id/inspections', 'inspection.read', (ctx, p) => {
      const agId = p['id']!;
      this.ownedAgreement(ctx, agId);
      return { status: 200, body: { inspections: this.inspections.forAgreement(agId) } };
    });

    // --- common-area reservations (#6) ------------------------------------
    this.add('POST', '/reservations', 'reservation.manage', (ctx, _p, body) => {
      const id = this.requireString(body, 'id');
      const spaceId = this.requireString(body, 'spaceId');
      const space = this.spaces.get(ctx.tenantId, spaceId);
      if (!space) throw new HttpError(404, 'space not found');
      if (space.type !== 'common' && space.type !== 'amenity') {
        throw new HttpError(400, 'space is not bookable (only common/amenity spaces can be reserved)');
      }
      const holderPartyId = this.requireString(body, 'holderPartyId');
      if (!this.parties.getParty(ctx.tenantId, holderPartyId)) throw new HttpError(404, 'holder party not found');
      const start = this.requireString(body, 'start');
      const end = this.requireString(body, 'end');
      const reservedAt = this.optString(body, 'reservedAt') ?? this.now();
      const priceCents = typeof body['priceCents'] === 'number' ? (body['priceCents'] as number) : undefined;
      return this.gated(
        'reservation.create',
        ctx,
        { spaceId },
        () => this.reservations.reserve({
          id, tenantId: ctx.tenantId, spaceId, holderPartyId, start, end, reservedAt,
          priceCents, currency: this.config.get(ctx.tenantId).currency, note: this.optString(body, 'note'),
        }),
        (r) => ({ status: 201, body: r }),
      );
    });

    this.add('POST', '/reservations/:id/cancel', 'reservation.manage', (ctx, p, body) => {
      const id = this.ownedReservation(ctx, p['id']!).id;
      const at = this.optString(body, 'at') ?? this.now();
      return this.gated('reservation.cancel', ctx, { id }, () => this.reservations.cancel(id, at), (r) => ({ status: 200, body: r }));
    });

    this.add('GET', '/reservations', 'reservation.read', (ctx) => ({
      status: 200,
      body: { reservations: this.reservations.list(ctx.tenantId) },
    }));

    this.add('GET', '/reservations/:id', 'reservation.read', (ctx, p) => ({ status: 200, body: this.ownedReservation(ctx, p['id']!) }));

    // --- integrations / connector framework (#7 #12 #13 #14 #16 #17) ------
    this.add('POST', '/integrations', 'integration.manage', (ctx, _p, body) => {
      const id = this.requireString(body, 'id');
      const kind = this.requireString(body, 'kind') as IntegrationKind;
      const provider = this.requireString(body, 'provider');
      const config = body['config'] && typeof body['config'] === 'object' ? (body['config'] as Record<string, unknown>) : {};
      return this.gated(
        'integration.configure',
        ctx,
        { kind, provider },
        // register() rejects secret-like config keys — credentials never reach the kernel.
        () => this.integrations.register({ id, tenantId: ctx.tenantId, kind, provider, config, secretRef: this.optString(body, 'secretRef'), createdAt: this.now() }),
        (rec) => ({ status: 201, body: rec }),
      );
    });

    this.add('GET', '/integrations', 'integration.read', (ctx) => ({ status: 200, body: { integrations: this.integrations.list(ctx.tenantId) } }));

    this.add('POST', '/integrations/:id/status', 'integration.manage', (ctx, p, body) => {
      this.ownedIntegration(ctx, p['id']!);
      const status = this.requireString(body, 'status') as IntegrationStatus;
      if (status !== 'active' && status !== 'disabled') throw new HttpError(400, "status must be active|disabled");
      return { status: 200, body: this.integrations.setStatus(p['id']!, status) };
    });

    // Enqueue an outbound command (unlock a door, push inventory, pull leads…).
    // The command lands in the outbox; an edge adapter that holds the credentials
    // dispatches it and reports the result.
    this.add('POST', '/integrations/:id/commands', 'connector.dispatch', (ctx, p, body) => {
      const integ = this.ownedIntegration(ctx, p['id']!);
      if (integ.status !== 'active') throw new HttpError(409, 'integration is disabled');
      const id = this.requireString(body, 'id');
      const action = this.requireString(body, 'action');
      const payload = body['payload'] && typeof body['payload'] === 'object' ? (body['payload'] as Record<string, unknown>) : {};
      // A bank/payment-gateway command carrying a large amountCents is a real
      // payout — thread the integration kind + amount so pol-connector-dispatch-payout
      // escalates it (no parallel money-out rail around bill.pay).
      const payoutAmount = typeof payload['amountCents'] === 'number' ? (payload['amountCents'] as number) : undefined;
      return this.gated(
        'connector.dispatch',
        ctx,
        { integrationId: integ.id, action, integrationKind: integ.kind, amountCents: payoutAmount },
        () => this.connectorOutbox.enqueue({ id, tenantId: ctx.tenantId, integrationId: integ.id, action, payload, createdAt: this.now() }),
        (cmd) => ({ status: 201, body: cmd }),
      );
    });

    this.add('GET', '/connector-commands', 'integration.read', (ctx) => ({ status: 200, body: { commands: this.connectorOutbox.list(ctx.tenantId) } }));

    // Edge-worker callbacks: claim a pending command, then report its outcome.
    this.add('POST', '/connector-commands/:id/dispatch', 'connector.dispatch', (ctx, p, _b) => {
      const cmd = this.ownedCommand(ctx, p['id']!);
      return { status: 200, body: this.connectorOutbox.markDispatched(cmd.id, this.now()) };
    });

    this.add('POST', '/connector-commands/:id/result', 'connector.dispatch', (ctx, p, body) => {
      const cmd = this.ownedCommand(ctx, p['id']!);
      const ok = body['ok'] === true;
      const result = body['result'] && typeof body['result'] === 'object' ? (body['result'] as Record<string, unknown>) : undefined;
      return { status: 200, body: this.connectorOutbox.markResult(cmd.id, ok, this.now(), result) };
    });

    // --- bank reconciliation (#5) -----------------------------------------
    this.add('POST', '/bank-transactions', 'reconciliation.manage', (ctx, _p, body) => {
      const id = this.requireString(body, 'id');
      const amountCents = this.requireInt(body, 'amountCents');
      const postedAt = this.requireString(body, 'postedAt');
      const description = this.optString(body, 'description') ?? '';
      return this.gated(
        'recon.import',
        ctx,
        { id },
        () => this.reconciliation.import({ id, tenantId: ctx.tenantId, amountCents, postedAt, description, reference: this.optString(body, 'reference'), bankAccountId: this.optString(body, 'bankAccountId') }),
        (txn) => ({ status: 201, body: txn }),
      );
    });

    this.add('POST', '/bank-transactions/:id/match', 'reconciliation.manage', (ctx, p, body) => {
      const txn = this.ownedBankTxn(ctx, p['id']!);
      const targetType = this.requireString(body, 'targetType') as MatchTargetType;
      const targetId = this.requireString(body, 'targetId');
      const ok = this.matchCandidates(ctx.tenantId).some((c) => c.type === targetType && c.id === targetId);
      if (!ok) throw new HttpError(404, 'no matching payment/ap_payment for this tenant');
      return this.gated('recon.match', ctx, { id: txn.id }, () => this.reconciliation.match(txn.id, targetType, targetId, this.now()), (t) => ({ status: 200, body: t }));
    });

    this.add('POST', '/bank-transactions/:id/unmatch', 'reconciliation.manage', (ctx, p, _b) => {
      const txn = this.ownedBankTxn(ctx, p['id']!);
      return this.gated('recon.match', ctx, { id: txn.id }, () => this.reconciliation.unmatch(txn.id), (t) => ({ status: 200, body: t }));
    });

    this.add('POST', '/bank-transactions/:id/ignore', 'reconciliation.manage', (ctx, p, _b) => {
      const txn = this.ownedBankTxn(ctx, p['id']!);
      return this.gated('recon.match', ctx, { id: txn.id }, () => this.reconciliation.ignore(txn.id), (t) => ({ status: 200, body: t }));
    });

    this.add('GET', '/bank-transactions', 'reconciliation.read', (ctx) => ({ status: 200, body: { transactions: this.reconciliation.list(ctx.tenantId) } }));

    // The txn plus its ranked auto-match suggestions (the AI seam, deterministic).
    this.add('GET', '/bank-transactions/:id', 'reconciliation.read', (ctx, p) => {
      const txn = this.ownedBankTxn(ctx, p['id']!);
      const suggestions = txn.status === 'unmatched' ? suggestMatches(txn, this.matchCandidates(ctx.tenantId)) : [];
      return { status: 200, body: { transaction: txn, suggestions } };
    });

    this.add('GET', '/reconciliation/summary', 'reconciliation.read', (ctx) => ({ status: 200, body: this.reconciliation.summary(ctx.tenantId) }));

    // --- revenue management & dynamic pricing (#1) ------------------------
    // Pricing rules and quotes are configuration + pure computation, so they
    // are RBAC-gated only (like config/master-data) — no PolicyEnvelope action.
    this.add('POST', '/pricing-rules', 'revenue.manage', (ctx, _p, body) => {
      const rule: PricingRule = {
        id: this.requireString(body, 'id'),
        tenantId: ctx.tenantId,
        name: this.requireString(body, 'name'),
        baseCents: this.requireInt(body, 'baseCents'),
        ...(typeof body['minCents'] === 'number' ? { minCents: body['minCents'] as number } : {}),
        ...(typeof body['maxCents'] === 'number' ? { maxCents: body['maxCents'] as number } : {}),
        ...(typeof body['weekendFactorBps'] === 'number' ? { weekendFactorBps: body['weekendFactorBps'] as number } : {}),
        ...(Array.isArray(body['occupancyTiers']) ? { occupancyTiers: body['occupancyTiers'] as OccupancyTier[] } : {}),
        ...(Array.isArray(body['leadTimeTiers']) ? { leadTimeTiers: body['leadTimeTiers'] as LeadTimeTier[] } : {}),
        ...(Array.isArray(body['losDiscounts']) ? { losDiscounts: body['losDiscounts'] as LosDiscount[] } : {}),
        ...(Array.isArray(body['seasons']) ? { seasons: body['seasons'] as SeasonWindow[] } : {}),
      };
      return { status: 201, body: this.revenue.setRule(rule) };
    });

    this.add('GET', '/pricing-rules', 'revenue.read', (ctx) => ({ status: 200, body: { rules: this.revenue.listRules(ctx.tenantId) } }));

    this.add('GET', '/pricing-rules/:id', 'revenue.read', (ctx, p) => {
      const rule = this.revenue.getRule(ctx.tenantId, p['id']!);
      if (!rule) throw new HttpError(404, 'pricing rule not found');
      return { status: 200, body: rule };
    });

    // Quote a rule for a stay. The occupancy/demand signal is supplied by the
    // caller (the AI/demand seam) — the arithmetic is deterministic.
    this.add('POST', '/pricing/quote', 'revenue.read', (ctx, _p, body) => {
      const ruleId = this.requireString(body, 'ruleId');
      const rule = this.revenue.getRule(ctx.tenantId, ruleId);
      if (!rule) throw new HttpError(404, 'pricing rule not found');
      const qc: QuoteContext = {
        checkIn: this.requireString(body, 'checkIn'),
        nights: this.requireInt(body, 'nights'),
        ...(typeof body['occupancyPct'] === 'number' ? { occupancyPct: body['occupancyPct'] as number } : {}),
        ...(typeof body['asOf'] === 'string' ? { asOf: body['asOf'] as string } : {}),
      };
      return { status: 200, body: this.revenue.quote(ctx.tenantId, ruleId, qc) };
    });

    // Headline KPIs — occupancy / ADR / RevPAR — folded from tenant state.
    this.add('GET', '/revenue/summary', 'revenue.read', (ctx) => ({ status: 200, body: this.revenueSummary(ctx.tenantId) }));

    // --- purchase orders & budgets (#2) -----------------------------------
    // A PO is an encumbrance, not a journal entry: raising/approving one commits
    // budget but posts NOTHING to the ledger — the AP bill is what hits the GL.
    this.add('POST', '/purchase-orders', 'procurement.manage', (ctx, _p, body) => {
      const id = this.requireString(body, 'id');
      const vendorId = this.requireString(body, 'vendorId');
      if (!this.parties.getParty(ctx.tenantId, vendorId)) throw new HttpError(404, 'vendor party not found');
      const entityId = this.optString(body, 'entityId');
      if (entityId && !this.entities.getEntity(ctx.tenantId, entityId)) throw new HttpError(404, 'entity not found');
      const rawLines = Array.isArray(body['lines']) ? (body['lines'] as unknown[]) : [];
      const lines: PurchaseOrderLine[] = rawLines.map((l) => {
        const o = l as Record<string, unknown>;
        return { description: String(o['description'] ?? ''), account: String(o['account'] ?? ''), amountCents: Number(o['amountCents']) };
      });
      const currency = this.config.get(ctx.tenantId).currency;
      return this.gated(
        'purchase_order.raise',
        ctx,
        { id },
        () => this.procurement.raise({ id, tenantId: ctx.tenantId, vendorId, entityId, createdAt: this.now(), expectedAt: this.optString(body, 'expectedAt'), currency, lines, memo: this.optString(body, 'memo') }),
        (po) => ({ status: 201, body: po }),
      );
    });

    this.add('POST', '/purchase-orders/:id/approve', 'procurement.manage', (ctx, p, _b) => {
      const po = this.ownedPurchaseOrder(ctx, p['id']!);
      // amountCents drives the large-PO escalation rule.
      return this.gated('purchase_order.approve', ctx, { id: po.id, amountCents: po.totalCents }, () => this.procurement.approve(po.id, this.now()), (r) => ({ status: 200, body: r }));
    });

    this.add('POST', '/purchase-orders/:id/receive', 'procurement.manage', (ctx, p, _b) => {
      const po = this.ownedPurchaseOrder(ctx, p['id']!);
      return this.gated('purchase_order.receive', ctx, { id: po.id }, () => this.procurement.receive(po.id, this.now()), (r) => ({ status: 200, body: r }));
    });

    this.add('POST', '/purchase-orders/:id/close', 'procurement.manage', (ctx, p, _b) => {
      const po = this.ownedPurchaseOrder(ctx, p['id']!);
      return this.gated('purchase_order.close', ctx, { id: po.id }, () => this.procurement.close(po.id, this.now()), (r) => ({ status: 200, body: r }));
    });

    this.add('POST', '/purchase-orders/:id/cancel', 'procurement.manage', (ctx, p, _b) => {
      const po = this.ownedPurchaseOrder(ctx, p['id']!);
      return this.gated('purchase_order.cancel', ctx, { id: po.id }, () => this.procurement.cancel(po.id, this.now()), (r) => ({ status: 200, body: r }));
    });

    this.add('GET', '/purchase-orders', 'procurement.read', (ctx) => ({ status: 200, body: { purchaseOrders: this.procurement.list(ctx.tenantId) } }));

    this.add('GET', '/purchase-orders/:id', 'procurement.read', (ctx, p) => ({ status: 200, body: this.ownedPurchaseOrder(ctx, p['id']!) }));

    // Budgets are configuration → RBAC-only (no PolicyEnvelope action).
    this.add('POST', '/budgets', 'procurement.manage', (ctx, _p, body) => {
      const budget: Budget = {
        id: this.requireString(body, 'id'),
        tenantId: ctx.tenantId,
        account: this.requireString(body, 'account'),
        periodStart: this.requireString(body, 'periodStart'),
        periodEnd: this.requireString(body, 'periodEnd'),
        amountCents: this.requireInt(body, 'amountCents'),
        ...(typeof body['label'] === 'string' ? { label: body['label'] as string } : {}),
      };
      return { status: 201, body: this.procurement.setBudget(budget) };
    });

    this.add('GET', '/budgets', 'procurement.read', (ctx) => ({
      status: 200,
      body: { budgets: this.procurement.listBudgets(ctx.tenantId).map((b) => ({ ...b, status: this.budgetStatus(ctx.tenantId, b) })) },
    }));

    this.add('GET', '/budgets/:id/status', 'procurement.read', (ctx, p) => {
      const b = this.procurement.getBudget(ctx.tenantId, p['id']!);
      if (!b) throw new HttpError(404, 'budget not found');
      return { status: 200, body: { budget: b, status: this.budgetStatus(ctx.tenantId, b) } };
    });

    // --- student roommate matching (#9) -----------------------------------
    // Matching is config-like pure computation → RBAC-only (no PolicyEnvelope).
    this.add('POST', '/prospects', 'roommate.manage', (ctx, _p, body) => {
      const partyId = this.optString(body, 'partyId');
      if (partyId && !this.parties.getParty(ctx.tenantId, partyId)) throw new HttpError(404, 'party not found');
      const prefs = (body['preferences'] && typeof body['preferences'] === 'object' ? body['preferences'] : {}) as Record<string, unknown>;
      const num = (k: string): number | undefined => (typeof prefs[k] === 'number' ? (prefs[k] as number) : undefined);
      const bool = (k: string): boolean | undefined => (typeof prefs[k] === 'boolean' ? (prefs[k] as boolean) : undefined);
      const preferences: RoommatePreferences = {
        ...(num('budgetCents') !== undefined ? { budgetCents: num('budgetCents') } : {}),
        ...(num('cleanliness') !== undefined ? { cleanliness: num('cleanliness') } : {}),
        ...(num('social') !== undefined ? { social: num('social') } : {}),
        ...(typeof prefs['chronotype'] === 'string' ? { chronotype: prefs['chronotype'] as Chronotype } : {}),
        ...(bool('smoker') !== undefined ? { smoker: bool('smoker') } : {}),
        ...(bool('hasPet') !== undefined ? { hasPet: bool('hasPet') } : {}),
        ...(bool('smokeFreeOnly') !== undefined ? { smokeFreeOnly: bool('smokeFreeOnly') } : {}),
        ...(bool('petFreeOnly') !== undefined ? { petFreeOnly: bool('petFreeOnly') } : {}),
      };
      return { status: 201, body: this.roommates.upsertProspect({ id: this.requireString(body, 'id'), tenantId: ctx.tenantId, name: this.requireString(body, 'name'), partyId, preferences }) };
    });

    this.add('GET', '/prospects', 'roommate.read', (ctx) => ({ status: 200, body: { prospects: this.roommates.list(ctx.tenantId) } }));

    this.add('GET', '/prospects/:id', 'roommate.read', (ctx, p) => {
      const prospect = this.ownedProspect(ctx, p['id']!);
      return { status: 200, body: { prospect, matches: this.roommates.matchesFor(ctx.tenantId, prospect.id) } };
    });

    this.add('GET', '/prospects/:id/matches', 'roommate.read', (ctx, p) => {
      this.ownedProspect(ctx, p['id']!);
      return { status: 200, body: { matches: this.roommates.matchesFor(ctx.tenantId, p['id']!) } };
    });

    this.add('POST', '/roommate/grouping', 'roommate.read', (ctx, _p, body) => {
      const capacity = this.requireInt(body, 'capacity');
      return { status: 200, body: { groups: this.roommates.suggestGrouping(ctx.tenantId, capacity) } };
    });

    // --- CSV + AI onboarding importer (#15) -------------------------------
    // Bulk-migrate an existing portfolio. Preview is a pure dry-run; commit
    // applies the ok rows to master data. Reuses masterdata.manage (config).
    this.add('POST', '/onboarding/preview', 'masterdata.manage', (_ctx, _p, body) => {
      const { target, headers, rows, mapping } = this.parseOnboarding(body);
      return { status: 200, body: { target, headers, mapping, plan: planImport(target, headers, rows, mapping) } };
    });

    this.add('POST', '/onboarding/commit', 'masterdata.manage', (ctx, _p, body) => {
      const { target, headers, rows, mapping } = this.parseOnboarding(body);
      const plan = planImport(target, headers, rows, mapping);
      const existing = new Set(
        (target === 'units' ? this.masterData.units.list(ctx.tenantId) : this.masterData.guests.list(ctx.tenantId)).map((r) => r.code),
      );
      let created = 0;
      let skipped = 0;
      for (const row of plan.rows) {
        if (row.status !== 'ok' || !row.record) continue;
        const code = row.record['code']!;
        if (existing.has(code)) { skipped++; continue; }
        const id = `${target === 'units' ? 'unit' : 'guest'}-${code}`;
        if (target === 'units') this.masterData.units.add({ id, tenantId: ctx.tenantId, code, label: row.record['label'] ?? code, active: true });
        else this.masterData.guests.add({ id, tenantId: ctx.tenantId, code, fullName: row.record['fullName']!, email: row.record['email'] });
        existing.add(code);
        created++;
      }
      return { status: 201, body: { target, created, skipped, errorRows: plan.errorCount, total: plan.rows.length } };
    });

    // --- CRM & pipeline (#20) ---------------------------------------------
    // The leasing sales funnel + its KPIs. Config/reporting → RBAC-only; the
    // real lease execution still runs through the agreement + lease.execute path.
    this.add('POST', '/leads', 'crm.manage', (ctx, _p, body) => {
      const partyId = this.optString(body, 'partyId');
      if (partyId && !this.parties.getParty(ctx.tenantId, partyId)) throw new HttpError(404, 'party not found');
      const lead = this.crm.createLead({
        id: this.requireString(body, 'id'),
        tenantId: ctx.tenantId,
        name: this.requireString(body, 'name'),
        source: this.optString(body, 'source'),
        estValueCents: typeof body['estValueCents'] === 'number' ? (body['estValueCents'] as number) : 0,
        partyId,
        createdAt: this.now(),
      });
      return { status: 201, body: lead };
    });

    this.add('POST', '/leads/:id/advance', 'crm.manage', (ctx, p, body) => {
      this.ownedLead(ctx, p['id']!);
      const to = this.requireString(body, 'stage') as LeadStage;
      return { status: 200, body: this.crm.advance(p['id']!, to, this.now()) };
    });

    this.add('POST', '/leads/:id/lose', 'crm.manage', (ctx, p, body) => {
      this.ownedLead(ctx, p['id']!);
      return { status: 200, body: this.crm.lose(p['id']!, this.optString(body, 'reason') ?? 'unspecified', this.now()) };
    });

    this.add('GET', '/leads', 'crm.read', (ctx) => ({ status: 200, body: { leads: this.crm.list(ctx.tenantId) } }));

    this.add('GET', '/leads/:id', 'crm.read', (ctx, p) => ({ status: 200, body: this.ownedLead(ctx, p['id']!) }));

    this.add('GET', '/crm/summary', 'crm.read', (ctx) => ({ status: 200, body: this.crm.kpis(ctx.tenantId) }));

    // --- e-signature for lease execution (#17) ----------------------------
    // The CRM → lease → e-sign tail. The provider I/O lives in an edge adapter
    // (secretRef); a fully signed envelope advances the CRM lead but does NOT
    // execute the lease — lease.execute stays a human-gated escalation.
    this.add('POST', '/signature-envelopes', 'esign.manage', (ctx, _p, body) => {
      const leadId = this.optString(body, 'leadId');
      if (leadId) this.ownedLead(ctx, leadId); // 404 if not this tenant's lead
      const agreementId = this.optString(body, 'agreementId');
      if (agreementId) this.ownedAgreement(ctx, agreementId);
      const rawSigners = Array.isArray(body['signers']) ? (body['signers'] as unknown[]) : [];
      const signers = rawSigners.map((s) => {
        const o = s as Record<string, unknown>;
        return { name: String(o['name'] ?? ''), email: String(o['email'] ?? ''), role: String(o['role'] ?? 'resident'), partyId: this.optString(o, 'partyId'), order: typeof o['order'] === 'number' ? (o['order'] as number) : undefined };
      });
      const env = this.signatures.create({
        id: this.requireString(body, 'id'),
        tenantId: ctx.tenantId,
        documentName: this.requireString(body, 'documentName'),
        provider: this.requireString(body, 'provider'),
        leadId, agreementId, signers, createdAt: this.now(),
      });
      return { status: 201, body: env };
    });

    this.add('POST', '/signature-envelopes/:id/send', 'esign.manage', (ctx, p, body) => {
      const env = this.ownedEnvelope(ctx, p['id']!);
      return this.gated('esign.send', ctx, { id: env.id }, () => this.signatures.send(env.id, this.now(), this.optString(body, 'providerRef')), (e) => ({ status: 200, body: e }));
    });

    // Record a signer's completion. This IS the provider's webhook, relayed by
    // the service role — it requires esign.complete (NOT esign.manage), so an
    // operator/agent cannot forge a signature by POSTing an email. When the
    // envelope was dispatched to a real provider it carries a providerRef (the
    // external envelope id); the callback must present the matching providerRef,
    // proving it is a genuine provider callback and not a spoofed request. When
    // every signer has signed, advance the linked CRM lead to 'signed' — the SALES
    // outcome. The binding lease execution stays a separate human step.
    this.add('POST', '/signature-envelopes/:id/sign', 'esign.complete', (ctx, p, body) => {
      const env = this.ownedEnvelope(ctx, p['id']!);
      if (env.providerRef && this.optString(body, 'providerRef') !== env.providerRef) {
        throw new HttpError(403, 'providerRef mismatch: completion must be relayed from the provider');
      }
      const email = this.requireString(body, 'email');
      if (body['decline'] === true) {
        return { status: 200, body: this.signatures.decline(env.id, email, this.optString(body, 'reason') ?? 'declined', this.now()) };
      }
      const { envelope, completed } = this.signatures.recordSigned(env.id, email, this.now());
      if (completed && envelope.leadId) {
        try {
          const lead = this.crm.get(envelope.leadId);
          if (lead.tenantId === ctx.tenantId && lead.stage !== 'signed' && lead.stage !== 'lost') this.crm.advance(envelope.leadId, 'signed', this.now());
        } catch { /* lead gone — envelope still records the signature */ }
      }
      return { status: 200, body: { envelope, completed } };
    });

    this.add('POST', '/signature-envelopes/:id/void', 'esign.manage', (ctx, p, body) => {
      const env = this.ownedEnvelope(ctx, p['id']!);
      return { status: 200, body: this.signatures.void(env.id, this.optString(body, 'reason') ?? 'voided', this.now()) };
    });

    this.add('GET', '/signature-envelopes', 'esign.read', (ctx) => ({ status: 200, body: { envelopes: this.signatures.list(ctx.tenantId) } }));

    this.add('GET', '/signature-envelopes/:id', 'esign.read', (ctx, p) => ({ status: 200, body: this.ownedEnvelope(ctx, p['id']!) }));

    // --- ledger (tenant-scoped) -------------------------------------------
    this.add('GET', '/ledger/trial-balance', 'ledger.read', (ctx) => ({ status: 200, body: this.trialBalance(ctx.tenantId) }));

    // --- exceptions --------------------------------------------------------
    this.add('GET', '/exceptions', 'exception.read', (ctx) => ({
      status: 200,
      body: { pending: this.exceptions.pending().filter((i) => (i.ctx as { tenantId?: string }).tenantId === ctx.tenantId) },
    }));

    this.add('POST', '/exceptions/:id/approve', 'exception.approve', (ctx, p, body) => {
      const item = this.exceptions.get(p['id']!); // throws -> 409 if unknown
      if ((item.ctx as { tenantId?: string }).tenantId !== ctx.tenantId) throw new HttpError(404, 'exception not found');
      const result = this.exceptions.approve(p['id']!, ctx.actor, this.now(), this.optString(body, 'note'));
      return { status: 200, body: { status: 'approved', result: result ?? null } };
    });

    // --- billing / reporting ----------------------------------------------
    this.add('GET', '/billing/subscription', 'subscription.read', (ctx) => ({
      status: 200,
      body: meterSubscription(this.masterData.units.list(ctx.tenantId).length, this.plan),
    }));

    // A reporting-friendly rollup: agreements by kind/status, ledger, master-data
    // counts, subscription — a single call for dashboards and exports.
    this.add('GET', '/reporting/summary', 'ledger.read', (ctx) => {
      const mine = [...this.agreements.values()].filter((e) => e.tenantId === ctx.tenantId).map((e) => e.agreement);
      const byKind: Record<string, number> = {};
      const byStatus: Record<string, number> = {};
      for (const a of mine) {
        byKind[a.kind] = (byKind[a.kind] ?? 0) + 1;
        byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;
      }
      const md = this.masterData.snapshot(ctx.tenantId);
      return {
        status: 200,
        body: {
          tenant: this.config.get(ctx.tenantId),
          agreements: { total: mine.length, byKind, byStatus },
          ledger: this.trialBalance(ctx.tenantId),
          subscription: meterSubscription(md.units.length, this.plan),
          masterDataCounts: { units: md.units.length, guests: md.guests.length, users: md.users.length, ratePlans: md.ratePlans.length },
        },
      };
    });
  }

  private tenantHasUnits(tenantId: string): boolean {
    return this.masterData.units.list(tenantId).length > 0;
  }

  private trialBalance(tenantId: string) {
    const ids = new Set([...this.agreements.values()].filter((e) => e.tenantId === tenantId).map((e) => e.agreement.id));
    const balances: Record<string, number> = {};
    for (const line of this.ledger.allLines) {
      if (!line.agreementId || !ids.has(line.agreementId)) continue;
      balances[line.account] = (balances[line.account] ?? 0) + line.debitCents - line.creditCents;
    }
    const net = Object.values(balances).reduce((s, v) => s + v, 0);
    return { balances, net, balanced: net === 0 };
  }

  /**
   * Fold tenant state into the headline hospitality KPIs (occupancy / ADR /
   * RevPAR). Sold room-nights = the summed nights of every agreement's period;
   * available room-nights = unit count × the span of the booked window; revenue
   * = collected invoice cash for the tenant. Deterministic and read-only.
   */
  private revenueSummary(tenantId: string) {
    const mine = [...this.agreements.values()].filter((e) => e.tenantId === tenantId).map((e) => e.agreement);
    const nights = (a: Agreement) => Math.max(0, Math.round((Date.parse(a.period.end) - Date.parse(a.period.start)) / 86_400_000));
    const soldRoomNights = mine.reduce((s, a) => s + nights(a), 0);
    let windowNights = 0;
    if (mine.length) {
      const start = Math.min(...mine.map((a) => Date.parse(a.period.start)));
      const end = Math.max(...mine.map((a) => Date.parse(a.period.end)));
      windowNights = Math.max(0, Math.round((end - start) / 86_400_000));
    }
    const unitCount = this.masterData.units.list(tenantId).length;
    const availableRoomNights = unitCount * windowNights;
    const revenueCents = this.billing.allInvoices()
      .filter((i) => i.tenantId === tenantId)
      .reduce((s, i) => s + i.paidCents, 0);
    return {
      ...revenueKpis({ availableRoomNights, soldRoomNights, revenueCents }),
      availableRoomNights,
      soldRoomNights,
      revenueCents,
      unitCount,
      windowNights,
    };
  }

  /** Posted (non-void) bill spend on an account within [start, end) — the
   *  "actual" leg of a budget. Bills are the GL-hitting side; POs are not. */
  private actualForAccount(tenantId: string, account: string, start: string, end: string): number {
    let sum = 0;
    for (const bill of this.payables.allBills()) {
      if (bill.tenantId !== tenantId || bill.status === 'void') continue;
      if (bill.issuedAt < start || bill.issuedAt >= end) continue;
      for (const l of bill.lines) if (l.account === account) sum += l.amountCents;
    }
    return sum;
  }

  /** Fold a budget's committed (open POs) + actual (posted bills) into a status. */
  private budgetStatus(tenantId: string, b: Budget) {
    const committed = this.procurement.committedForAccount(tenantId, b.account, b.periodStart, b.periodEnd);
    const actual = this.actualForAccount(tenantId, b.account, b.periodStart, b.periodEnd);
    return computeBudgetStatus(b, committed, actual);
  }

  // --- durable persistence (the persist-world Edge Function) ----------------
  /**
   * Fold this App's in-memory state for one tenant into a WorldData — the exact
   * payload the persist-world function projects and writes. FK parents first;
   * children filtered by ownership so the batch is self-consistent.
   *
   * With `since` (a FlushMark), only NEW rows of the append-only streams
   * (agreement events, journal lines, action log) and lines of not-yet-flushed
   * invoices are included; state/parent rows are always included and upserted by
   * the projection. This makes a repeat flush an idempotent incremental sync.
   */
  snapshotWorld(tenantId: string, since?: FlushMark): WorldData {
    const cfg = this.config.get(tenantId);
    const mine = [...this.agreements.values()].filter((e) => e.tenantId === tenantId);
    const agreementIds = new Set(mine.map((e) => e.agreement.id));
    const invoices = this.billing.allInvoices().filter((i) => i.tenantId === tenantId);
    const invoiceIds = new Set(invoices.map((i) => i.id));
    const bills = this.payables.allBills().filter((b) => b.tenantId === tenantId);
    const billIds = new Set(bills.map((b) => b.id));
    const threadIds = new Set(this.comms.listThreads(tenantId).map((th) => th.id));

    return {
      // The tenant row now carries its full country-environment config.
      tenants: [{ id: tenantId, name: cfg.displayName ?? tenantId, displayName: cfg.displayName, locale: cfg.locale, currency: cfg.currency, timezone: cfg.timezone, businessStructure: cfg.businessStructure, country: cfg.country, jurisdiction: cfg.jurisdiction }],
      units: this.masterData.units.list(tenantId).map((u) => ({ id: u.id, tenantId, label: u.label, code: u.code, active: u.active })),
      guests: this.masterData.guests.list(tenantId).map((g) => ({ id: g.id, tenantId, fullName: g.fullName, code: g.code, email: g.email })),
      ratePlans: this.masterData.ratePlans.list(tenantId).map((r) => ({
        id: r.id, tenantId, name: r.name, kind: r.kind, baseCents: r.baseMinor, currency: cfg.currency,
      })),
      agreements: mine.map((e) => ({
        id: e.agreement.id,
        tenantId,
        // Emit the legacy guest_id only when it is a real guest; otherwise the
        // resident is carried by the party role link (agreement_party).
        guestId: this.masterData.guests.get(tenantId, e.agreement.guestId) ? e.agreement.guestId : null,
        unitId: e.agreement.unitId, // the created unit (a valid FK); transfers live in the events + hold

        // Only events past the mark for this agreement (append-only — never resent).
        events: e.agreement.history.slice(since?.events[e.agreement.id] ?? 0),
      })),
      holds: this.calendar.allHolds().filter((h) => agreementIds.has(h.holderId)),
      // Tenant-scoped journal lines are append-ordered; slice the tail past the mark.
      journalLines: this.ledger.allLines
        .filter((l) => l.agreementId != null && agreementIds.has(l.agreementId))
        .slice(since?.journalLines ?? 0),
      // Invoice rows always sent (upserted for status); their lines only for
      // invoices not yet flushed (invoice_line is append-only, no natural key).
      invoices: invoices.map((inv) =>
        since?.invoiceLines.includes(inv.id) ? { ...inv, lines: [] } : inv,
      ),
      payments: this.payments.all().filter((p) => invoiceIds.has(p.invoiceId)),
      deposits: this.deposits.all().filter((d) => agreementIds.has(d.agreementId)),
      // Tenant-scoped: the action log is a shared append-only stream, so filter
      // to THIS tenant before slicing the tail past the (per-tenant) mark.
      actionLog: this.runtime.actionLogFor(tenantId).slice(since?.actionLog ?? 0),
      // --- master-data reshape v2 (all upserted, so always safe to resend) ----
      legalEntities: this.entities.listEntities(tenantId),
      parties: this.parties.listParties(tenantId),
      spaces: this.spaces.list(tenantId),
      chargeTypes: this.entities.listChargeTypes(tenantId),
      agreementParties: this.parties.allLinks().filter((l) => agreementIds.has(l.agreementId)),
      // Bill rows always sent (upserted for status); their lines only for bills
      // not yet flushed (bill_line is append-only, no natural key).
      bills: bills.map((b) => (since?.bills.includes(b.id) ? { ...b, lines: [] } : b)),
      apPayments: this.payables.allPayments().filter((p) => billIds.has(p.billId)),
      workOrders: this.maintenance.list(tenantId),
      reservations: this.reservations.list(tenantId).map((r) => ({
        id: r.id, tenantId, spaceId: r.spaceId, holderPartyId: r.holderPartyId, start: r.start, end: r.end,
        priceCents: r.priceCents, currency: r.currency, status: r.status, reservedAt: r.reservedAt, cancelledAt: r.cancelledAt, note: r.note,
      })),
      inspections: this.inspections.list(tenantId),
      messageThreads: this.comms.listThreads(tenantId),
      messages: this.comms.allMessages().filter((m) => threadIds.has(m.threadId)),
      bankTransactions: this.reconciliation.list(tenantId),
      // --- feature wire-up (all upserted, so always safe to resend) ----------
      pricingRules: this.revenue.listRules(tenantId),
      purchaseOrders: this.procurement.list(tenantId),
      budgets: this.procurement.listBudgets(tenantId),
      prospects: this.roommates.list(tenantId).map((p) => ({ id: p.id, tenantId, name: p.name, partyId: p.partyId, preferences: p.preferences as Record<string, unknown> })),
      leads: this.crm.list(tenantId).map((l) => ({
        id: l.id, tenantId, name: l.name, source: l.source, stage: l.stage, estValueCents: l.estValueCents,
        partyId: l.partyId, createdAt: l.createdAt, updatedAt: l.updatedAt, stageAt: l.stageAt as Record<string, unknown>, lostReason: l.lostReason,
      })),
      // --- full persistence: platform users, custom roles, e-sign, connectors --
      users: this.masterData.users.list(tenantId),
      customRoles: this.roles.customRolesFor(tenantId).map((r) => ({ tenantId, roleId: r.id, name: r.name, description: r.description, permissions: r.permissions === '*' ? [...this.roles.permissionsFor(tenantId, r.id)] : (r.permissions as readonly string[]) })),
      integrations: this.integrations.list(tenantId),
      connectorCommands: this.connectorOutbox.list(tenantId),
      signatureEnvelopes: this.signatures.list(tenantId).map((e) => ({
        id: e.id, tenantId, documentName: e.documentName, provider: e.provider, providerRef: e.providerRef,
        leadId: e.leadId, agreementId: e.agreementId, signers: e.signers, status: e.status,
        createdAt: e.createdAt, sentAt: e.sentAt, completedAt: e.completedAt, voidReason: e.voidReason, declineReason: e.declineReason,
      })),
    };
  }

  /**
   * Cold-start rehydration: reconstitute this App's full in-memory state from a
   * WorldData read back out of the DB (Repositories.loadWorld). The symmetric
   * inverse of snapshotWorld — after a restart the app restores everything the
   * persistence layer captured, so nothing lives only in memory. Loads are
   * side-effect-free (no ledger re-post): journal lines are restored as stored.
   */
  rehydrate(world: WorldData): void {
    for (const t of world.tenants) {
      this.config.set({
        tenantId: t.id, displayName: t.displayName ?? t.name,
        locale: t.locale ?? 'en', currency: t.currency ?? 'USD', timezone: t.timezone ?? 'UTC',
        businessStructure: t.businessStructure ?? 'mixed_portfolio', country: t.country ?? 'US', jurisdiction: t.jurisdiction ?? 'US',
      });
    }
    // Master data (unit code/active + guest code/email are all persisted now).
    for (const u of world.units) this.masterData.units.add({ id: u.id, tenantId: u.tenantId, code: u.code ?? u.id, label: u.label, active: u.active ?? true });
    for (const g of world.guests) this.masterData.guests.add({ id: g.id, tenantId: g.tenantId, code: g.code ?? g.id, fullName: g.fullName, email: g.email });
    for (const r of world.ratePlans ?? []) this.masterData.ratePlans.add({ id: r.id, tenantId: r.tenantId, code: r.id, name: r.name, kind: r.kind as 'nightly' | 'monthly' | 'lease', baseMinor: r.baseCents });
    for (const u of world.users ?? []) this.masterData.users.add({ id: u.id, tenantId: u.tenantId, code: u.code, displayName: u.displayName, roleId: u.roleId, active: u.active });
    for (const cr of world.customRoles ?? []) this.roles.defineRole(cr.tenantId, { id: cr.roleId, name: cr.name, permissions: cr.permissions as Permission[], description: cr.description });
    // Pass the world records through verbatim — they already carry the exact
    // stored shape, so we don't introduce explicit-undefined optional keys.
    for (const e of world.legalEntities ?? []) this.entities.addEntity(e as never);
    for (const p of world.parties ?? []) this.parties.addParty(p as never);
    // Spaces parents-first (self-referencing tree).
    const spaces = [...(world.spaces ?? [])];
    const placed = new Set<string>();
    let guard = spaces.length * spaces.length + 1;
    while (spaces.length && guard-- > 0) {
      const idx = spaces.findIndex((s) => !s.parentId || placed.has(s.parentId));
      const s = spaces.splice(idx === -1 ? 0 : idx, 1)[0]!;
      placed.add(s.id);
      this.spaces.add(s as never);
    }
    for (const c of world.chargeTypes ?? []) this.entities.addChargeType(c as never);
    this.ledger.hydrate(world.journalLines);
    this.calendar.hydrate(world.holds);
    for (const a of world.agreements) {
      const ag = Agreement.rehydrate({ id: a.id, tenantId: a.tenantId, guestId: a.guestId ?? '', unitId: a.unitId }, a.events);
      this.agreements.set(a.id, { agreement: ag, tenantId: a.tenantId });
    }
    for (const l of world.agreementParties ?? []) this.parties.assign(l as never);
    this.billing.hydrate(world.invoices);
    for (const inv of world.invoices) this.invoiceTenant.set(inv.id, inv.tenantId);
    this.payments.hydrate(world.payments);
    this.deposits.hydrate(world.deposits);
    for (const d of world.deposits) { const t = this.agreements.get(d.agreementId)?.tenantId; if (t) this.depositTenant.set(d.id, t); }
    this.payables.hydrate((world.bills ?? []) as never, (world.apPayments ?? []) as never);
    this.maintenance.hydrate((world.workOrders ?? []) as never);
    this.reservations.hydrate((world.reservations ?? []) as never);
    this.inspections.hydrate((world.inspections ?? []) as never);
    this.comms.hydrate((world.messageThreads ?? []) as never, (world.messages ?? []) as never);
    this.reconciliation.hydrate((world.bankTransactions ?? []) as never);
    for (const pr of world.pricingRules ?? []) this.revenue.setRule(pr as never);
    this.procurement.hydrate((world.purchaseOrders ?? []) as never, (world.budgets ?? []) as never);
    for (const p of world.prospects ?? []) this.roommates.upsertProspect(p as never);
    this.crm.hydrate((world.leads ?? []) as never);
    this.signatures.hydrate((world.signatureEnvelopes ?? []) as never);
    this.integrations.hydrate((world.integrations ?? []) as never);
    this.connectorOutbox.hydrate((world.connectorCommands ?? []) as never);
    this.runtime.hydrateLog(world.actionLog);
  }

  /** The high-water mark of what a tenant's full current state would flush. */
  private highWaterMark(tenantId: string): FlushMark {
    const mine = [...this.agreements.values()].filter((e) => e.tenantId === tenantId);
    const agreementIds = new Set(mine.map((e) => e.agreement.id));
    const events: Record<string, number> = {};
    for (const e of mine) events[e.agreement.id] = e.agreement.history.length;
    return {
      events,
      journalLines: this.ledger.allLines.filter((l) => l.agreementId != null && agreementIds.has(l.agreementId)).length,
      actionLog: this.runtime.actionLogFor(tenantId).length,
      invoiceLines: this.billing.allInvoices().filter((i) => i.tenantId === tenantId).map((i) => i.id),
      bills: this.payables.allBills().filter((b) => b.tenantId === tenantId).map((b) => b.id),
    };
  }

  /**
   * Flush a tenant's world to durable storage through the injected backend
   * (the persist-world Edge Function in production). Async because it does real
   * I/O — kept off the synchronous dispatch() router and exposed directly so the
   * HTTP layer can await it. Enforces the same auth + RBAC gates as dispatch.
   *
   * Incremental: only rows appended since the last successful flush are sent, so
   * calling it repeatedly against the append-only tables is safe. The mark
   * advances only on success (the function applies the batch in one transaction,
   * so success means every row landed).
   */
  async persist(req: ApiRequest): Promise<ApiResponse> {
    const ctx = this.auth.authenticate(req.bearer);
    if (!ctx) return { status: 401, body: { error: 'unauthenticated' } };
    const perms = this.roles.permissionsFor(ctx.tenantId, ctx.role);
    if (!perms.has('persistence.run')) {
      return { status: 403, body: { error: 'forbidden', permission: 'persistence.run' } };
    }
    if (!this.persistence) {
      return { status: 501, body: { error: 'no_persistence_backend', detail: 'App constructed without a persistence backend' } };
    }
    const mark = this.flushMarks.get(ctx.tenantId);
    const world = this.snapshotWorld(ctx.tenantId, mark);
    const nextMark = this.highWaterMark(ctx.tenantId);
    const delta = {
      events: world.agreements.reduce((n, a) => n + a.events.length, 0),
      journalLines: world.journalLines.length,
      actionLog: world.actionLog.length,
      invoices: world.invoices.length,
    };
    try {
      const result = await this.persistence.persist(world);
      this.flushMarks.set(ctx.tenantId, nextMark); // advance only after success
      return { status: 200, body: { ...result, delta, incremental: mark !== undefined } };
    } catch (e) {
      // EdgePersistError carries the function's HTTP status + body; surface it.
      const status = (e as { status?: number }).status ?? 502;
      const detail = (e as { body?: unknown }).body ?? (e instanceof Error ? e.message : String(e));
      return { status, body: { error: 'persist_failed', detail } };
    }
  }
}
