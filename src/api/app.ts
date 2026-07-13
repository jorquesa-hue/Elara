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
import { Billing, ACCOUNTS, type InvoiceLine } from '../billing.ts';
import { stageFor, lateFeeCents } from '../collections.ts';
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
import { fullContract, isKnownAction, isKnownEvent } from '../integration-contract.ts';
import { Notifications, NOTIFICATION_KINDS, isKnownNotificationKind, type NotificationChannel } from '../notifications.ts';
import { defaultAdapterRegistry, AdapterError, type AdapterRegistry } from '../adapter-registry.ts';
import { RevenueManagement, revenueKpis, computeRevenueInsights, type PricingRule, type QuoteContext, type OccupancyTier, type LeadTimeTier, type LosDiscount, type SeasonWindow } from '../revenue.ts';
import { Procurement, computeBudgetStatus, type PurchaseOrderLine, type Budget } from '../procurement.ts';
import { RoommateMatcher, type RoommatePreferences, type Chronotype } from '../roommate.ts';
import { parseCsv, suggestMapping, planImport, type ImportTarget, type ColumnMapping } from '../onboarding.ts';
import { Crm, type LeadStage } from '../crm.ts';
import { Applications, type ScreeningResult } from '../application.ts';
import { PeriodLock } from '../period-lock.ts';
import { BankAccounts } from '../bank-account.ts';
import { gaapViewFromLines } from '../multigaap.ts';
import { Signatures } from '../esign.ts';
import { meterSubscription, type SubscriptionPlan } from '../subscription.ts';
import {
  ConfigStore,
  SUPPORTED_LOCALES,
  SUPPORTED_CURRENCIES,
  BUSINESS_STRUCTURES,
  assertBrandLogo,
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
import { defaultObservability, silentSink, type Observability } from '../observability.ts';
import { RateLimiter } from '../ratelimit.ts';
import { buildSubjectAccessReport, redactPartyRecord, redactRecipient, type ErasureReceipt } from '../compliance.ts';
import { recommendAccess } from '../access-advisor.ts';
import { buildReport, computeInsights, REPORT_CATALOG, type ReportingInput } from '../reporting.ts';
import { buildCustomReport, dataSources, type CustomReportSpec } from '../report-builder.ts';
import { siteListing, checkAvailability, isValidDate, type BookingSiteInput } from '../booking-site.ts';
import { SiteContentStore, SiteContentError, sanitizeSiteContent } from '../site-content.ts';
import { templateGallery, isKnownTemplate, resolveTheme } from '../site-templates.ts';
import { buildDemoWorld, DEMO_MARKER_UNIT_ID } from '../demo-data.ts';

export interface ApiRequest {
  method: string;
  path: string;
  body?: Record<string, unknown>;
  bearer?: string;
}

export interface ApiResponse {
  status: number;
  body: unknown;
  /** Optional response headers (e.g. Retry-After, a non-JSON content-type). The
   *  http binding merges these over its defaults; a string body is written raw. */
  headers?: Record<string, string>;
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
  /** The original pattern, used as a low-cardinality metric label (not the raw path). */
  pattern: string;
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
  /** Vendor adapter registry. Omit → the generic reference adapters. */
  adapters?: AdapterRegistry;
  /** Where the portal sends users to authenticate (Supabase Auth / GoTrue). When
   *  set, GET /auth/config advertises it so the SPA shows a real login; omit for
   *  the dev "paste a token" mode. The anonKey is a PUBLIC (publishable) key. */
  authConfig?: { authUrl: string; anonKey: string };
  /** Structured logging + metrics + error reporting. Omit → console logger + a
   *  fresh in-memory metrics registry (scrapable at GET /metrics). Inject partials
   *  to point at your own sink/reporter (e.g. Sentry) without a kernel dependency. */
  observability?: Partial<Observability>;
  /** Per-principal request rate limit. Pass a RateLimiter, or a {capacity,
   *  refillPerSec} to build a token bucket, or omit to disable limiting. */
  rateLimit?: RateLimiter | { capacity: number; refillPerSec: number };
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
  readonly notifications = new Notifications();
  private readonly authConfig?: { authUrl: string; anonKey: string };
  // The pluggable vendor adapter registry. A deployment can inject its own (with
  // real vendor adapters registered) via AppConfig.adapters; defaults to the
  // generic reference adapters.
  private readonly adapters: AdapterRegistry;
  readonly revenue = new RevenueManagement();
  readonly procurement = new Procurement();
  readonly roommates = new RoommateMatcher();
  readonly crm = new Crm();
  readonly applications = new Applications();
  readonly signatures = new Signatures();
  readonly periodLock = new PeriodLock();
  readonly bankAccounts = new BankAccounts();

  readonly config: ConfigStore;
  readonly roles: RoleRegistry;
  readonly masterData: MasterData;

  private readonly auth: Authenticator;
  private readonly plan: SubscriptionPlan;
  private readonly persistence?: PersistenceBackend;
  private readonly now: () => string;
  /** Structured logger + metrics registry + error reporter (see GET /metrics). */
  readonly obs: Observability;
  private readonly rateLimiter?: RateLimiter;
  private readonly agreements = new Map<string, { agreement: Agreement; tenantId: string }>();
  private readonly siteContent = new SiteContentStore();
  private readonly invoiceTenant = new Map<string, string>();
  private readonly depositTenant = new Map<string, string>();
  private readonly applicationTenant = new Map<string, string>();
  private readonly flushMarks = new Map<string, FlushMark>();
  /** Per-tenant in-flight flush, so overlapping flushes serialize (see flushWorld). */
  private readonly flushInFlight = new Map<string, Promise<void>>();
  private readonly routes: Route[] = [];

  constructor(config: AppConfig = {}) {
    // Enforce closed accounting periods at the single ledger chokepoint: no entry
    // may post into a closed month. The tenant is resolved from the entry's
    // tenantId or (agreement-linked entries) via the agreement.
    this.ledger.setPostingGuard(({ tenantId, agreementId, postedAt }) => {
      const tid = tenantId ?? (agreementId ? this.agreements.get(agreementId)?.tenantId : undefined);
      if (tid) this.periodLock.assertOpen(tid, postedAt);
    });
    this.runtime = new AgentRuntime(new PolicyEnvelope(), this.exceptions);
    this.billing = new Billing(this.ledger);
    this.payables = new Payables(this.ledger);
    this.payments = new Payments(this.ledger, this.billing);
    this.deposits = new Deposits(this.ledger);
    this.auth = config.authenticator ?? new StaticTokenAuthenticator();
    this.plan = config.subscriptionPlan ?? { perUnitCents: 5000, currency: 'BRL' };
    this.persistence = config.persistence;
    this.adapters = config.adapters ?? defaultAdapterRegistry();
    this.authConfig = config.authConfig;
    this.config = config.config ?? new ConfigStore();
    this.roles = config.roles ?? new RoleRegistry();
    this.masterData = config.masterData ?? new MasterData();
    this.now = config.now ?? (() => new Date().toISOString());
    // Silent by default (tests / in-process callers log nothing); a deployment
    // opts into a real sink via config.observability (main.ts wires stdout).
    this.obs = { ...defaultObservability({ sink: silentSink }), ...config.observability };
    this.rateLimiter =
      config.rateLimit instanceof RateLimiter
        ? config.rateLimit
        : config.rateLimit
          ? new RateLimiter(config.rateLimit)
          : undefined;
    for (const u of config.units ?? []) {
      if (!this.masterData.units.get(u.tenantId, u.id)) {
        this.masterData.units.add({ id: u.id, tenantId: u.tenantId, code: u.id, label: u.id, active: true });
      }
    }
    this.registerRoutes();
  }

  // --- transport-agnostic entry point --------------------------------------
  // A thin instrumentation shell around route(): every request emits a metrics
  // sample (count by method/route/status + a latency histogram) and a structured
  // log line, and an error that escapes a handler is captured (not leaked as a
  // stack) — so operations are observable without any per-handler boilerplate.
  dispatch(req: ApiRequest): ApiResponse {
    const startMs = Date.now();
    let routePattern = 'unmatched';
    let tenant = '-';
    let response: ApiResponse;
    try {
      const routed = this.route(req);
      response = routed.response;
      routePattern = routed.pattern;
      tenant = routed.tenant;
    } catch (e) {
      // A bug escaped a handler's own guard — report it and return a bare 500
      // rather than leak an internal stack to the caller.
      this.obs.errors.capture(e, { method: req.method, path: req.path });
      response = { status: 500, body: { error: 'internal error' } };
    }
    const durationMs = Date.now() - startMs;
    try {
      const m = this.obs.metrics;
      m.increment('http_requests_total', { method: req.method, route: routePattern, status: String(response.status) });
      m.observe('http_request_duration_ms', durationMs, { route: routePattern });
      if (response.status >= 500) m.increment('http_server_errors_total', { route: routePattern });
      this.obs.logger.info('request', { method: req.method, route: routePattern, status: response.status, tenant, durationMs });
    } catch {
      /* observability must never break a response */
    }
    return response;
  }

  /** The router proper. Returns the response plus the low-cardinality labels the
   *  dispatch() instrumentation needs (matched route pattern + tenant). */
  private route(req: ApiRequest): { response: ApiResponse; pattern: string; tenant: string } {
    // PUBLIC, pre-auth: the SPA fetches this to learn HOW to sign in (which is a
    // chicken-and-egg before it has a token). It exposes only the auth mode + the
    // GoTrue base URL + the PUBLIC anon key — never a secret.
    if (req.method === 'GET' && req.path === '/auth/config') {
      return {
        response: {
          status: 200,
          body: this.authConfig
            ? { mode: 'supabase', authUrl: this.authConfig.authUrl, anonKey: this.authConfig.anonKey }
            : { mode: 'dev' },
        },
        pattern: '/auth/config',
        tenant: '-',
      };
    }

    // PUBLIC, pre-auth: the guest-facing booking website. It exposes ONLY
    // marketing data (unit labels, prices, availability) for a tenant that has
    // published inventory — never residents, ledgers or any PII. A booking
    // request lands as a CRM lead in the operator's pipeline (no payment here).
    if (req.path.startsWith('/site/')) {
      const seg = req.path.split('/').filter(Boolean); // ['site', tenant, action?]
      const tenant = seg[1];
      const action = seg[2];
      if (tenant) {
        const res = this.bookingSiteRoute(req.method, tenant, action, req.body ?? {});
        if (res) return { response: res, pattern: `/site/:tenant${action ? '/' + action : ''}`, tenant };
      }
    }

    const ctx = this.auth.authenticate(req.bearer);
    if (!ctx) return { response: { status: 401, body: { error: 'unauthenticated' } }, pattern: 'unauthenticated', tenant: '-' };

    // Per-principal rate limit — keyed on tenant+actor so it applies AFTER auth
    // (an unauthenticated flood is bounded upstream at the edge/CDN, cheaply 401'd
    // here). Refused requests never reach a handler.
    if (this.rateLimiter) {
      const decision = this.rateLimiter.take(`${ctx.tenantId}:${ctx.actor}`);
      if (!decision.allowed) {
        this.obs.metrics.increment('http_rate_limited_total', { tenant: ctx.tenantId });
        return {
          response: {
            status: 429,
            body: { error: 'rate_limited', retryAfterSec: decision.retryAfterSec },
            headers: {
              'retry-after': String(decision.retryAfterSec),
              'x-ratelimit-limit': String(decision.limit),
              'x-ratelimit-remaining': String(decision.remaining),
            },
          },
          pattern: 'rate_limited',
          tenant: ctx.tenantId,
        };
      }
    }

    for (const route of this.routes) {
      if (route.method !== req.method) continue;
      const m = route.regex.exec(req.path);
      if (!m) continue;

      if (route.permission) {
        const perms = this.roles.permissionsFor(ctx.tenantId, ctx.role);
        if (!perms.has(route.permission)) {
          return { response: { status: 403, body: { error: 'forbidden', permission: route.permission } }, pattern: route.pattern, tenant: ctx.tenantId };
        }
      }

      const params: Record<string, string> = {};
      route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)));
      try {
        return { response: route.handler(ctx, params, req.body ?? {}), pattern: route.pattern, tenant: ctx.tenantId };
      } catch (e) {
        const status = statusForError(e);
        // A 500 is an unexpected fault (not a state conflict) — surface it to the reporter.
        if (status >= 500) this.obs.errors.capture(e, { route: route.pattern, tenant: ctx.tenantId, actor: ctx.actor });
        return { response: { status, body: { error: e instanceof Error ? e.message : String(e) } }, pattern: route.pattern, tenant: ctx.tenantId };
      }
    }
    return { response: { status: 404, body: { error: 'not found' } }, pattern: 'unmatched', tenant: ctx.tenantId };
  }

  private add(method: string, pattern: string, permission: Permission | null, handler: Route['handler']): void {
    const { regex, keys } = compile(pattern);
    this.routes.push({ method, pattern, regex, keys, permission, handler });
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
    // Every policy decision is a metric — the allow/escalate/deny split per action
    // is the headline signal for whether the envelope is behaving in production.
    try {
      this.obs.metrics.increment('policy_decisions_total', { action, outcome: result.outcome });
    } catch {
      /* never break a decision on a metric */
    }
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

  /** Resolve an optional typeId in a unit payload — 404s on an unknown type so
   *  a unit can never point at a floorplan that doesn't exist. */
  private unitTypeLink(tenantId: string, body: Record<string, unknown>): { typeId?: string } {
    const typeId = this.optString(body, 'typeId');
    if (typeId === undefined || typeId === '') return {};
    if (!this.masterData.unitTypes.get(tenantId, typeId)) throw new HttpError(404, `unknown unit type: ${typeId}`);
    return { typeId };
  }

  /** Resolve an optional propertyId in a unit payload — 404s on an unknown
   *  property so a unit can never point at a community that doesn't exist. */
  private unitPropertyLink(tenantId: string, body: Record<string, unknown>): { propertyId?: string } {
    const propertyId = this.optString(body, 'propertyId');
    if (propertyId === undefined || propertyId === '') return {};
    if (!this.masterData.properties.get(tenantId, propertyId)) throw new HttpError(404, `unknown property: ${propertyId}`);
    return { propertyId };
  }

  /** The property an agreement's money belongs to: its current unit's property.
   *  Used to stamp per-community P&L onto journal lines at posting time. */
  private propertyForAgreement(tenantId: string, agreementId: string): string | undefined {
    const e = this.agreements.get(agreementId);
    if (!e || e.tenantId !== tenantId) return undefined;
    const unit = this.masterData.units.get(tenantId, e.agreement.currentUnitId);
    return unit?.propertyId;
  }

  /** The optional numeric/description fields of a unit-type payload, validated. */
  private unitTypeFields(body: Record<string, unknown>) {
    const out: { bedrooms?: number; bathrooms?: number; maxGuests?: number; areaSqm?: number; baseRentCents?: number; description?: string } = {};
    for (const k of ['bedrooms', 'bathrooms', 'maxGuests', 'areaSqm', 'baseRentCents'] as const) {
      const v = body[k];
      if (v === undefined || v === null || v === '') continue;
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `invalid '${k}'`);
      out[k] = k === 'areaSqm' ? Math.round(n * 10) / 10 : Math.round(n);
    }
    const description = this.optString(body, 'description');
    if (description !== undefined) out.description = description.slice(0, 2000);
    return out;
  }

  private agreementSummary(a: Agreement) {
    // leaseExecuted is surfaced directly (folded from the event history) so API
    // consumers and the portal read binding status without scanning events.
    return { id: a.id, kind: a.kind, status: a.status, rateCents: a.rateCents, period: a.period, unitId: a.currentUnitId, leaseExecuted: a.leaseExecuted };
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

  /** Assemble a data-subject access report (LGPD/GDPR) for a party from the
   *  tenant-scoped slices across the stores. Throws 404 if the party is unknown. */
  private subjectAccessReport(tenantId: string, partyId: string) {
    const party = this.parties.getParty(tenantId, partyId);
    if (!party) throw new HttpError(404, 'party not found');
    const roles = this.parties.allLinks().filter((l) => l.partyId === partyId);
    const invoices = this.billing.allInvoices()
      .filter((i) => i.tenantId === tenantId && i.billToPartyId === partyId)
      .map((i) => ({ id: i.id, agreementId: i.agreementId, totalCents: i.totalCents, status: i.status, issuedAt: i.issuedAt }));
    const bills = this.payables.allBills()
      .filter((b) => b.tenantId === tenantId && b.payeeId === partyId)
      .map((b) => ({ id: b.id, totalCents: b.totalCents, status: b.status, issuedAt: b.issuedAt }));
    const notifications = party.email
      ? this.notifications.list(tenantId).filter((n) => n.to === party.email).map((n) => ({ id: n.id, channel: n.channel, kind: n.kind, status: n.status, createdAt: n.createdAt }))
      : [];
    const leads = this.crm.list(tenantId).filter((l) => l.partyId === partyId).map((l) => ({ id: l.id, stage: l.stage }));
    const prospects = this.roommates.list(tenantId).filter((r) => r.partyId === partyId).map((r) => ({ id: r.id, name: r.name }));
    return buildSubjectAccessReport({ generatedAt: this.now(), party, roles, invoices, bills, notifications, leads, prospects });
  }

  /** Execute an erasure: redact the party's PII + its notification recipients,
   *  keeping the financial record (role links, invoices, bills) by opaque id. */
  private erasePartyData(tenantId: string, partyId: string, reason?: string): ErasureReceipt {
    const at = this.now();
    const party = this.parties.getParty(tenantId, partyId);
    if (!party) throw new HttpError(404, 'party not found');
    const email = party.email;
    const redactedFields = this.parties.erase(tenantId, partyId, (pp) => redactPartyRecord(pp, at, reason));
    const notificationsRedacted = email ? this.notifications.redactRecipient(tenantId, email, redactRecipient()) : 0;
    const retained = {
      agreementRoles: this.parties.allLinks().filter((l) => l.partyId === partyId).length,
      invoices: this.billing.allInvoices().filter((i) => i.tenantId === tenantId && i.billToPartyId === partyId).length,
      bills: this.payables.allBills().filter((b) => b.tenantId === tenantId && b.payeeId === partyId).length,
    };
    return { partyId, erasedAt: at, redactedFields, notificationsRedacted, retained };
  }

  /** Best-effort recipient email for an agreement — the bill-to party's email.
   *  Used to address auto-notifications; undefined → the notification is skipped. */
  private emailForAgreement(tenantId: string, agreementId: string): string | undefined {
    const partyId = this.parties.billTo(agreementId);
    if (!partyId) return undefined;
    return this.parties.getParty(tenantId, partyId)?.email;
  }

  /** Enqueue a notification, swallowing any error — notifications are best-effort
   *  and must never break the domain write that triggered them. */
  private notify(input: { id: string; tenantId: string; channel: NotificationChannel; to?: string; kind: string; data: Record<string, unknown> }): void {
    if (!input.to) return;
    try { this.notifications.enqueue({ ...input, to: input.to, createdAt: this.now() }); } catch { /* dup / best-effort */ }
  }

  private ownedNotification(ctx: AuthContext, id: string) {
    let n;
    try { n = this.notifications.get(id); } catch { throw new HttpError(404, 'notification not found'); }
    if (n.tenantId !== ctx.tenantId) throw new HttpError(404, 'notification not found');
    return n;
  }

  /** Is this party currently a party (any role) on the agreement? */
  private callerLinkedToAgreement(partyId: string, agreementId: string): boolean {
    return this.parties.partiesFor(agreementId).some((l) => l.partyId === partyId);
  }

  /**
   * The overdue-collections sweep. For every open, past-due invoice, apply the
   * highest collection stage reached — each stage's action dispatched through the
   * policy envelope (remind/late_fee execute; suspend/evict escalate). Idempotent:
   * each (invoice, stage) is journaled as a message on a per-invoice collections
   * thread, so re-running never double-charges or re-escalates; a late fee posts a
   * receivable at most once (deterministic `latefee-<invoice>` id).
   */
  private runCollectionsSweep(ctx: AuthContext, at: string): {
    swept: number;
    actions: Array<{ invoiceId: string; stage: string; action: string; outcome: string; exceptionId?: string }>;
  } {
    const dayMs = 86_400_000;
    const nowMs = Date.parse(at);
    const jurisdiction = this.config.get(ctx.tenantId).jurisdiction;
    const overdue = this.billing
      .openInvoices()
      // A late fee posted by a prior sweep is itself an invoice — exclude it so the
      // sweep never charges a fee on a fee (or escalates one).
      .filter((i) => i.tenantId === ctx.tenantId && !i.id.startsWith('latefee-') && Date.parse(i.dueAt) < nowMs);
    const actions: Array<{ invoiceId: string; stage: string; action: string; outcome: string; exceptionId?: string }> = [];

    for (const inv of overdue) {
      const daysOverdue = Math.floor((nowMs - Date.parse(inv.dueAt)) / dayMs);
      const stage = stageFor(daysOverdue);
      if (!stage) continue;
      const threadId = `col-thread-${inv.id}`;
      const msgId = `col-${inv.id}-${stage.id}`;

      // Idempotency: this (invoice, stage) already processed?
      let processed = false;
      try { processed = this.comms.messagesFor(threadId).some((m) => m.id === msgId); } catch { processed = false; }
      if (processed) { actions.push({ invoiceId: inv.id, stage: stage.id, action: stage.action, outcome: 'already_applied' }); continue; }

      try { this.comms.getThread(threadId); }
      catch { this.comms.openThread({ id: threadId, tenantId: ctx.tenantId, subject: `Collections: invoice ${inv.id}`, kind: 'finance', createdAt: at, agreementId: inv.agreementId }); }

      const outstanding = inv.totalCents - inv.paidCents;
      const decision = this.runtime.execute(
        stage.policyAction,
        { actor: ctx.actor, tenantId: ctx.tenantId, jurisdiction, invoiceId: inv.id, amountCents: outstanding },
        at,
        () => {
          if (stage.action === 'late_fee' && stage.feeBps) {
            const fee = lateFeeCents(outstanding, stage.feeBps);
            const feeId = `latefee-${inv.id}`;
            if (fee > 0 && !this.billing.allInvoices().some((x) => x.id === feeId)) {
              this.billing.issue({
                id: feeId,
                agreementId: inv.agreementId,
                tenantId: ctx.tenantId,
                issuedAt: at,
                dueAt: inv.dueAt,
                currency: inv.currency,
                lines: [{ description: `Late fee (${stage.feeBps / 100}%) on ${inv.id}`, account: ACCOUNTS.lateFeeRevenue, amountCents: fee }],
              });
              this.invoiceTenant.set(feeId, ctx.tenantId);
            }
          }
          return true;
        },
      );

      // Journal the stage regardless of outcome so a re-sweep skips it (no dup
      // escalations for suspend/evict, which park pending a human).
      this.comms.post({ id: msgId, threadId, at, authorType: 'agent', authorId: ctx.actor, body: `Stage ${stage.id} (${stage.action}) → ${decision.outcome}`, direction: 'internal' });

      // A guest-facing money reminder (remind/late_fee) also enqueues an email so it
      // actually reaches the resident — best-effort, deduped by the stage message id.
      if (decision.outcome === 'executed' && (stage.action === 'remind' || stage.action === 'late_fee')) {
        this.notify({ id: `notif-${msgId}`, tenantId: ctx.tenantId, channel: 'email', to: this.emailForAgreement(ctx.tenantId, inv.agreementId), kind: 'collections_reminder', data: { invoiceId: inv.id, amountCents: outstanding } });
      }
      actions.push({ invoiceId: inv.id, stage: stage.id, action: stage.action, outcome: decision.outcome, ...(decision.exceptionId ? { exceptionId: decision.exceptionId } : {}) });
    }
    return { swept: overdue.length, actions };
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
    if (target !== 'units' && target !== 'guests' && target !== 'agreements') throw new HttpError(400, "target must be 'units', 'guests' or 'agreements'");
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

  private ownedApplication(ctx: AuthContext, id: string) {
    if (this.applicationTenant.get(id) !== ctx.tenantId) throw new HttpError(404, 'application not found');
    return this.applications.get(id);
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

  /** Deployment-visible health detail merged into GET /health (e.g. the lifecycle
   *  reports whether cold-start rehydration ran, degraded, or was disabled). */
  readonly health: Record<string, unknown> = {};

  private registerRoutes(): void {
    this.add('GET', '/health', null, () => ({ status: 200, body: { ok: true, ...this.health } }));

    // Process-wide operational metrics in Prometheus text format. Aggregate counts
    // (requests, latencies, policy decisions, rate-limits) — not tenant records —
    // gated behind metrics.scrape (owner/service/manager), which a deployment's
    // scraper carries. `?format=json` returns the structured snapshot instead.
    this.add('GET', '/metrics', 'metrics.scrape', (_ctx, _p, _b) => ({
      status: 200,
      body: this.obs.metrics.renderProm(),
      headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' },
    }));
    this.add('GET', '/metrics.json', 'metrics.scrape', () => ({ status: 200, body: this.obs.metrics.snapshot() }));

    // --- session / config --------------------------------------------------
    // Who am I + my permissions — the first call the portal makes.
    this.add('GET', '/me', null, (ctx) => ({
      status: 200,
      body: {
        actor: ctx.actor,
        tenantId: ctx.tenantId,
        role: ctx.role,
        ...(ctx.partyId ? { partyId: ctx.partyId } : {}),
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
      // Brand fields are orthogonal to country/jurisdiction — collect them once
      // and apply after whichever config path runs. A logo is validated + size-capped.
      const brand: Partial<Pick<TenantConfig, 'brandColor' | 'logoDataUrl' | 'tagline'>> = {};
      const brandColor = this.optString(body, 'brandColor');
      if (brandColor !== undefined) brand.brandColor = brandColor || undefined;
      const tagline = this.optString(body, 'tagline');
      if (tagline !== undefined) brand.tagline = tagline || undefined;
      const logo = this.optString(body, 'logoDataUrl');
      if (logo !== undefined) {
        try { brand.logoDataUrl = logo ? assertBrandLogo(logo) : undefined; }
        catch (e) { throw new HttpError(400, e instanceof Error ? e.message : 'invalid logo'); }
      }
      const applyBrand = (cfg: TenantConfig) => (Object.keys(brand).length ? this.config.update(ctx.tenantId, brand) : cfg);

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
        const apply = () => applyBrand(this.config.setupForCountry(ctx.tenantId, displayName, country, overrides));
        if (established && next !== current) {
          return this.gated('config.change_jurisdiction', ctx, { from: current, to: next }, apply, (cfg) => ({ status: 200, body: cfg }));
        }
        return { status: 200, body: apply() };
      }
      const patch: Partial<Omit<TenantConfig, 'tenantId'>> = { ...brand };
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
        ...this.unitTypeLink(ctx.tenantId, body),
        ...this.unitPropertyLink(ctx.tenantId, body),
      }),
    }));

    // Update a property/unit — rename, activate/deactivate, re-type, or move to
    // another property. Deactivating keeps history (reports still reference it)
    // but drops it from the bookable set.
    this.add('PUT', '/units/:id', 'masterdata.manage', (ctx, p, body) => {
      if (!this.masterData.units.get(ctx.tenantId, p['id']!)) throw new HttpError(404, 'unit not found');
      const patch: { label?: string; active?: boolean; typeId?: string | undefined; propertyId?: string | undefined } = {};
      const label = this.optString(body, 'label');
      if (label !== undefined) patch.label = label;
      if (typeof body['active'] === 'boolean') patch.active = body['active'] as boolean;
      if (body['typeId'] === '') patch.typeId = undefined; // '' unlinks the floorplan
      else Object.assign(patch, this.unitTypeLink(ctx.tenantId, body));
      if (body['propertyId'] === '') patch.propertyId = undefined; // '' unlinks the property
      else Object.assign(patch, this.unitPropertyLink(ctx.tenantId, body));
      return { status: 200, body: this.masterData.units.update(ctx.tenantId, p['id']!, patch) };
    });

    // --- bank accounts (operating vs trust) — deposit segregation ------------
    this.add('GET', '/bank-accounts', 'entity.read', (ctx) => ({ status: 200, body: { bankAccounts: this.bankAccounts.list(ctx.tenantId) } }));

    this.add('POST', '/bank-accounts', 'entity.manage', (ctx, _p, body) => {
      const code = this.requireString(body, 'code');
      const kind = this.optString(body, 'kind') === 'trust' ? 'trust' : 'operating';
      const entityId = this.optString(body, 'entityId');
      if (entityId && !this.entities.getEntity(ctx.tenantId, entityId)) throw new HttpError(404, `unknown legal entity: ${entityId}`);
      // A trust account gets its own segregated GL cash account by default.
      const glAccount = this.optString(body, 'glAccount') ?? (kind === 'trust' ? `assets:cash:trust:${code.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : 'assets:cash');
      return {
        status: 201,
        body: this.bankAccounts.add({
          id: this.optString(body, 'id') ?? `bank-${code.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
          tenantId: ctx.tenantId, code, name: this.requireString(body, 'name'), kind, glAccount,
          ...(entityId ? { entityId } : {}),
        }),
      };
    });

    // --- properties / communities — the multi-property rollup dimension ------
    this.add('GET', '/properties', 'masterdata.read', (ctx) => ({ status: 200, body: { properties: this.masterData.properties.list(ctx.tenantId) } }));

    this.add('POST', '/properties', 'masterdata.manage', (ctx, _p, body) => {
      const code = this.requireString(body, 'code');
      const entityId = this.optString(body, 'entityId');
      if (entityId && !this.entities.getEntity(ctx.tenantId, entityId)) throw new HttpError(404, `unknown legal entity: ${entityId}`);
      return {
        status: 201,
        body: this.masterData.properties.add({
          id: this.optString(body, 'id') ?? `prop-${code.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
          tenantId: ctx.tenantId,
          code,
          name: this.requireString(body, 'name'),
          ...(this.optString(body, 'address') !== undefined ? { address: this.optString(body, 'address') } : {}),
          ...(entityId ? { entityId } : {}),
        }),
      };
    });

    this.add('PUT', '/properties/:id', 'masterdata.manage', (ctx, p, body) => {
      if (!this.masterData.properties.get(ctx.tenantId, p['id']!)) throw new HttpError(404, 'property not found');
      const patch: Record<string, unknown> = {};
      for (const k of ['name', 'address'] as const) { const v = this.optString(body, k); if (v !== undefined) patch[k] = v; }
      if (body['entityId'] === '') patch['entityId'] = undefined;
      else { const e = this.optString(body, 'entityId'); if (e) { if (!this.entities.getEntity(ctx.tenantId, e)) throw new HttpError(404, `unknown legal entity: ${e}`); patch['entityId'] = e; } }
      return { status: 200, body: this.masterData.properties.update(ctx.tenantId, p['id']!, patch) };
    });

    // --- unit types (floorplans) — the multifamily merchandising unit --------
    // A 200-unit building is a handful of floorplans; details/base rent are
    // entered ONCE on the type and every unit of that type inherits them.
    this.add('GET', '/unit-types', 'masterdata.read', (ctx) => ({ status: 200, body: { unitTypes: this.masterData.unitTypes.list(ctx.tenantId) } }));

    this.add('POST', '/unit-types', 'masterdata.manage', (ctx, _p, body) => {
      const code = this.requireString(body, 'code');
      return {
        status: 201,
        body: this.masterData.unitTypes.add({
          id: this.optString(body, 'id') ?? `utype-${code.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
          tenantId: ctx.tenantId,
          code,
          name: this.requireString(body, 'name'),
          ...this.unitTypeFields(body),
        }),
      };
    });

    this.add('PUT', '/unit-types/:id', 'masterdata.manage', (ctx, p, body) => {
      if (!this.masterData.unitTypes.get(ctx.tenantId, p['id']!)) throw new HttpError(404, 'unit type not found');
      const patch: Record<string, unknown> = this.unitTypeFields(body);
      const name = this.optString(body, 'name');
      if (name !== undefined) patch['name'] = name;
      return { status: 200, body: this.masterData.unitTypes.update(ctx.tenantId, p['id']!, patch) };
    });

    // Bulk unit generation — the "add a 200-apartment property" path. One call
    // creates `count` units code `<codePrefix><n>` (n from startNumber), all
    // linked to a floorplan; codes already in use are SKIPPED (idempotent), so
    // re-running or overlapping ranges never duplicates inventory.
    this.add('POST', '/units/bulk', 'masterdata.manage', (ctx, _p, body) => {
      const codePrefix = this.requireString(body, 'codePrefix');
      const count = typeof body['count'] === 'number' && Number.isInteger(body['count']) ? (body['count'] as number) : NaN;
      if (!(count >= 1 && count <= 500)) throw new HttpError(400, 'count must be an integer between 1 and 500');
      const start = typeof body['startNumber'] === 'number' && Number.isInteger(body['startNumber']) ? (body['startNumber'] as number) : 101;
      const labelPrefix = this.optString(body, 'labelPrefix') ?? codePrefix;
      const link = { ...this.unitTypeLink(ctx.tenantId, body), ...this.unitPropertyLink(ctx.tenantId, body) };
      const existing = new Set(this.masterData.units.list(ctx.tenantId).map((u) => u.code));
      const created: string[] = [];
      const skipped: string[] = [];
      for (let n = start; n < start + count; n++) {
        const code = `${codePrefix}${n}`;
        if (existing.has(code)) { skipped.push(code); continue; }
        this.masterData.units.add({
          id: `unit-${code.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
          tenantId: ctx.tenantId, code, label: `${labelPrefix}${n}`, active: true, ...link,
        });
        created.push(code);
      }
      return { status: 201, body: { created: created.length, skipped: skipped.length, codes: created, skippedCodes: skipped } };
    });

    // --- website content (the integrated booking-site builder) ------------
    // The operator-authored page: hero/about/contact plus per-unit marketing
    // details and publish switches. Marketing data only — validated + size-capped.
    this.add('GET', '/site-content', 'masterdata.read', (ctx) => ({ status: 200, body: { content: this.siteContent.get(ctx.tenantId) } }));

    // The 20-template design gallery the Website builder's picker renders.
    this.add('GET', '/site-templates', 'masterdata.read', () => ({ status: 200, body: { templates: templateGallery() } }));

    this.add('PUT', '/site-content', 'masterdata.manage', (ctx, _p, body) => {
      try {
        return { status: 200, body: { content: this.siteContent.set(ctx.tenantId, body['content'] ?? body) } };
      } catch (e) {
        if (e instanceof SiteContentError) throw new HttpError(400, e.message);
        throw e;
      }
    });

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
      const propertyId = this.propertyForAgreement(ctx.tenantId, agreementId);
      return this.gated(
        'invoice.issue',
        ctx,
        { agreementId },
        () => {
          const inv = this.billing.issue({ id, agreementId, tenantId: ctx.tenantId, issuedAt, dueAt, currency, lines, receivingEntityId, billToPartyId, propertyId });
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
      const propertyId = this.propertyForAgreement(ctx.tenantId, this.billing.get(invoiceId).agreementId);
      return this.gated(
        'payment.record',
        ctx,
        { amountCents, invoiceId },
        () => this.payments.record({ id, invoiceId, amountCents, method, receivedAt, propertyId }),
        (pay) => {
          // Email the payer a receipt (best-effort) via the invoice's agreement.
          const agreementId = this.billing.get(invoiceId).agreementId;
          this.notify({ id: `notif-receipt-${pay.id}`, tenantId: ctx.tenantId, channel: 'email', to: this.emailForAgreement(ctx.tenantId, agreementId), kind: 'payment_receipt', data: { invoiceId, amountCents } });
          return { status: 201, body: pay };
        },
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
      const propertyId = this.propertyForAgreement(ctx.tenantId, agreementId);
      // Segregate deposit cash into a TRUST account when the tenant has one — it
      // has its own GL cash account so deposits never commingle with operating
      // cash (a jurisdictional requirement for security deposits).
      const trust = this.bankAccounts.trustFor(ctx.tenantId);
      return this.gated(
        'deposit.hold',
        ctx,
        { agreementId, amountCents },
        () => {
          const d = this.deposits.hold({ id, agreementId, amountCents, currency, heldAt, ...(trust ? { cashAccount: trust.glAccount, entityId: trust.entityId } : {}), ...(propertyId ? { propertyId } : {}) });
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
          // ATOMICITY: acquire the TARGET hold first, so a double-inventory
          // conflict on the destination aborts the whole transfer before any
          // state mutates (no transferred event, old hold intact). Only after
          // both the hold and the event succeed are the superseded holds
          // released — a failure at any step leaves the agreement untouched.
          if (toUnitId === a.currentUnitId) throw new HttpError(400, 'agreement already occupies that unit/space');
          const { start, end } = a.period;
          const newHoldId = `${a.id}-hold-${a.history.length + 1}`;
          this.calendar.hold({ id: newHoldId, unitId: toUnitId, holderId: a.id, start, end });
          try {
            a.transfer(toUnitId, at, opts);
          } catch (e) {
            this.calendar.release(newHoldId); // undo the probe hold; nothing else changed
            throw e;
          }
          for (const h of this.calendar.activeHolds()) {
            if (h.holderId === a.id && h.id !== newHoldId) this.calendar.release(h.id);
          }
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
          // ATOMICITY: validate the PO can absorb this billing BEFORE the bill
          // posts its GL entry, so a refusal (over-billing, wrong status) can
          // never leave a booked-and-payable bill behind a 409.
          const totalCents = lines.reduce((s, l) => s + l.amountCents, 0);
          if (poId) this.procurement.assertCanBill(poId, totalCents);
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

    // Legally EXECUTE (bind) a lease. lease.execute ESCALATES in every jurisdiction
    // (regulated + irreversible), so this ALWAYS parks for human approval (202) and
    // is never auto-executed — the binding only runs when a human approves the
    // exception. Distinct from converting the agreement kind to 'lease'.
    this.add('POST', '/agreements/:id/execute-lease', 'agreement.execute', (ctx, p, body) => {
      const a = this.ownedAgreement(ctx, p['id']!);
      const at = this.optString(body, 'at') ?? this.now();
      return this.gated('lease.execute', ctx, { id: a.id }, () => { a.executeLease(at, { documentRef: this.optString(body, 'documentRef'), note: this.optString(body, 'note') }); return a; }, (ag) => ({ status: 200, body: this.agreementSummary(ag) }));
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

    // The canonical capability contract every port speaks — for agent/portal
    // discovery of what actions/events each kind supports, independent of vendor.
    this.add('GET', '/integrations/capabilities', 'integration.read', () => ({ status: 200, body: { contract: fullContract() } }));

    // What THIS integration's vendor adapter can do (resolved from the registry).
    this.add('GET', '/integrations/:id/capabilities', 'integration.read', (ctx, p) => {
      const integ = this.ownedIntegration(ctx, p['id']!);
      const adapter = this.adapters.resolve(integ.kind, integ.provider);
      return {
        status: 200,
        body: {
          kind: integ.kind,
          provider: integ.provider,
          adapterRegistered: adapter !== null,
          enabled: adapter?.enabled ?? false,
          actions: adapter ? adapter.actions : [],
          contractActions: fullContract().find((c) => c.kind === integ.kind)?.actions ?? [],
        },
      };
    });

    // Enqueue an outbound command (unlock a door, push inventory, pull leads…).
    // The command lands in the outbox; the connector-worker edge function resolves
    // the secretRef and dispatches it. If a vendor adapter is registered for this
    // (kind, provider), the action is validated against its capabilities and a
    // CREDENTIAL-FREE vendor request template is attached (_request) so the edge is
    // pure plumbing (inject the secret + execute). No adapter → the command still
    // enqueues (the edge falls back / simulates), preserving back-compat.
    this.add('POST', '/integrations/:id/commands', 'connector.dispatch', (ctx, p, body) => {
      const integ = this.ownedIntegration(ctx, p['id']!);
      if (integ.status !== 'active') throw new HttpError(409, 'integration is disabled');
      const id = this.requireString(body, 'id');
      const action = this.requireString(body, 'action');
      const payload: Record<string, unknown> = body['payload'] && typeof body['payload'] === 'object' ? { ...(body['payload'] as Record<string, unknown>) } : {};

      const adapter = this.adapters.resolve(integ.kind, integ.provider);
      if (adapter) {
        if (!adapter.actions.includes(action)) {
          throw new HttpError(400, `action '${action}' not supported by ${integ.provider}; supported: ${adapter.actions.join(', ')}`);
        }
        // Build the credential-free vendor request now (pure). A disabled adapter
        // (e.g. a money rail awaiting human sign-off) attaches nothing → the edge
        // won't call the vendor; the routing policy refuses money kinds regardless.
        if (adapter.enabled) {
          try { payload['_request'] = adapter.buildRequest(action, payload, integ.config); }
          catch (e) { throw new HttpError(400, e instanceof AdapterError ? e.message : 'adapter could not build the request'); }
        }
      }

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

    // The generic INBOUND port: a vendor-initiated event (a bank transaction pushed,
    // a CRM lead created, a door forced) relayed by the service role (the edge, which
    // holds the credential, verifies the provider signature BEFORE relaying — the
    // kernel requires integration.events, NOT an OPS role). The event must be in the
    // kind's contract; it is then routed to the right domain: bank→reconciliation,
    // crm→a lead, everything else recorded on a per-integration events thread.
    // Idempotent on the provider's eventId.
    this.add('POST', '/integrations/:id/events', 'integration.events', (ctx, p, body) => {
      const integ = this.ownedIntegration(ctx, p['id']!);
      const event = this.requireString(body, 'event');
      if (!isKnownEvent(integ.kind, event)) throw new HttpError(400, `event '${event}' is not a '${integ.kind}' contract event`);
      const eventId = this.requireString(body, 'eventId');
      const payload = body['payload'] && typeof body['payload'] === 'object' ? (body['payload'] as Record<string, unknown>) : {};
      const at = this.optString(body, 'at') ?? this.now();
      try {
        if (integ.kind === 'bank' && event === 'transaction_posted') {
          const txn = this.reconciliation.import({
            id: `evt-${eventId}`,
            tenantId: ctx.tenantId,
            postedAt: this.optString(payload, 'postedAt') ?? at,
            amountCents: Number(payload['amountCents']),
            description: this.optString(payload, 'description') ?? `${integ.provider} transaction`,
            bankAccountId: this.optString(payload, 'bankAccountId'),
            reference: this.optString(payload, 'reference'),
          });
          return { status: 201, body: { routed: 'bank_transaction', id: txn.id } };
        }
        if (integ.kind === 'crm' && event === 'lead_created') {
          const lead = this.crm.createLead({
            id: `evt-${eventId}`,
            tenantId: ctx.tenantId,
            name: this.optString(payload, 'name') ?? 'Lead',
            source: integ.provider,
            estValueCents: typeof payload['estValueCents'] === 'number' ? (payload['estValueCents'] as number) : 0,
            createdAt: at,
          });
          return { status: 201, body: { routed: 'crm_lead', id: lead.id } };
        }
        // Default: durably record the event on a per-integration inbound thread.
        const threadId = `integration-events-${integ.id}`;
        try { this.comms.getThread(threadId); }
        catch { this.comms.openThread({ id: threadId, tenantId: ctx.tenantId, subject: `Integration events: ${integ.provider}`, kind: 'internal', createdAt: at }); }
        const msg = this.comms.post({ id: `evt-${eventId}`, threadId, at, authorType: 'agent', authorId: integ.provider, body: `${event}: ${JSON.stringify(payload)}`, direction: 'internal' });
        return { status: 201, body: { routed: 'recorded', id: msg.id } };
      } catch (e) {
        // Idempotent: a re-delivered eventId (already processed) is a no-op, not an error.
        if (e instanceof Error && /duplicate/i.test(e.message)) return { status: 200, body: { routed: 'duplicate', eventId } };
        throw e;
      }
    });

    // --- fiscal document emission (NF-e / NFS-e) --------------------------
    // Emitting an electronic fiscal invoice is an OUTBOUND connector command to
    // the tenant's `fiscal` integration (Focus NFe / NFe.io / a municipal NFS-e
    // gateway). Same discipline as every connector: the kernel enqueues a
    // CREDENTIAL-FREE command (the adapter attaches the vendor _request template),
    // the connector-worker edge function resolves the certificate/API key from the
    // secret store and performs the real call, and the authorization comes back
    // asynchronously via POST /integrations/:id/events (fiscal.invoice_authorized).
    // Gated connector.dispatch (fiscal is a dispatchable, non-money kind).
    this.add('POST', '/invoices/:id/emit-nfe', 'connector.dispatch', (ctx, p, _body) => {
      const invoiceId = p['id']!;
      if (this.invoiceTenant.get(invoiceId) !== ctx.tenantId) throw new HttpError(404, 'invoice not found');
      const inv = this.billing.get(invoiceId);
      const integ = this.integrations.list(ctx.tenantId, { kind: 'fiscal' }).find((i) => i.status === 'active');
      if (!integ) throw new HttpError(409, 'no active fiscal integration configured for this tenant');

      // Recipient tax id (CPF/CNPJ) comes from the invoice's bill-to party — never a secret.
      const billToTaxId = inv.billToPartyId ? this.parties.getParty(ctx.tenantId, inv.billToPartyId)?.taxId : undefined;
      const payload: Record<string, unknown> = {
        invoiceId: inv.id,
        agreementId: inv.agreementId,
        totalCents: inv.totalCents,
        currency: inv.currency,
        issuedAt: inv.issuedAt,
        lines: inv.lines.map((l) => ({ description: l.description, amountCents: l.amountCents })),
        recipient: { taxId: billToTaxId },
      };
      const adapter = this.adapters.resolve(integ.kind, integ.provider);
      if (adapter) {
        if (!adapter.actions.includes('emit_invoice')) throw new HttpError(400, `${integ.provider} does not support emit_invoice`);
        if (adapter.enabled) {
          try { payload['_request'] = adapter.buildRequest('emit_invoice', payload, integ.config); }
          catch (e) { throw new HttpError(400, e instanceof AdapterError ? e.message : 'adapter could not build the request'); }
        }
      }
      return this.gated(
        'connector.dispatch',
        ctx,
        { integrationId: integ.id, action: 'emit_invoice', integrationKind: integ.kind },
        () => this.connectorOutbox.enqueue({ id: `nfe-${invoiceId}`, tenantId: ctx.tenantId, integrationId: integ.id, action: 'emit_invoice', payload, createdAt: this.now() }),
        (cmd) => ({ status: 202, body: { status: 'queued', command: cmd } }),
      );
    });

    // --- notifications (email/SMS transport) ------------------------------
    // The kernel RECORDS a notification; the notification-worker edge function
    // drains the outbox and sends it, resolving the provider credential from the
    // secret store — no credential ever enters the kernel. Enqueuing is routine
    // (OPS); an edge worker reports delivery via the callbacks below.
    this.add('GET', '/notification-kinds', 'notification.read', () => ({ status: 200, body: { kinds: NOTIFICATION_KINDS } }));

    this.add('POST', '/notifications', 'notification.send', (ctx, _p, body) => {
      const channel = this.requireString(body, 'channel') as NotificationChannel;
      const kind = this.requireString(body, 'kind');
      if (!isKnownNotificationKind(kind)) throw new HttpError(400, `unknown notification kind '${kind}'`);
      const data = body['data'] && typeof body['data'] === 'object' ? (body['data'] as Record<string, unknown>) : {};
      return {
        status: 201,
        body: this.notifications.enqueue({ id: this.requireString(body, 'id'), tenantId: ctx.tenantId, channel, to: this.requireString(body, 'to'), kind, data, createdAt: this.now() }),
      };
    });

    this.add('GET', '/notifications', 'notification.read', (ctx) => ({ status: 200, body: { notifications: this.notifications.list(ctx.tenantId) } }));

    // Edge-worker delivery callbacks (service role holds notification.send via '*').
    this.add('POST', '/notifications/:id/sent', 'notification.send', (ctx, p, body) => {
      const n = this.ownedNotification(ctx, p['id']!);
      return { status: 200, body: this.notifications.markSent(n.id, this.now(), this.optString(body, 'providerRef')) };
    });
    this.add('POST', '/notifications/:id/failed', 'notification.send', (ctx, p, body) => {
      const n = this.ownedNotification(ctx, p['id']!);
      return { status: 200, body: this.notifications.markFailed(n.id, this.now(), this.optString(body, 'reason') ?? 'failed') };
    });

    // --- privacy / data-subject rights (LGPD/GDPR) ------------------------
    // Right of access: a subject-access export of everything Elara holds about a
    // party. Operator-gated (privacy.export = DPO/manager); a party-scoped token
    // (a guest) may export ONLY its own party. The route permission is null so the
    // handler can allow either path — a guest lacks privacy.export by design.
    this.add('GET', '/privacy/parties/:id/export', null, (ctx, p) => {
      const id = p['id']!;
      if (ctx.partyId !== undefined) {
        if (ctx.partyId !== id) throw new HttpError(404, 'party not found');
      } else if (!this.roles.permissionsFor(ctx.tenantId, ctx.role).has('privacy.export')) {
        return { status: 403, body: { error: 'forbidden', permission: 'privacy.export' } };
      }
      return { status: 200, body: this.subjectAccessReport(ctx.tenantId, id) };
    });

    // Right to erasure: redact the party's PII while RETAINING the append-only
    // financial events (invariant 1) by opaque id. Policy-gated (privacy.erase,
    // allow+audited) and restricted to privacy.manage (a human DPO — never an
    // agent). The action_log records who erased whom and when.
    this.add('POST', '/privacy/parties/:id/erase', 'privacy.manage', (ctx, p, body) => {
      const id = p['id']!;
      const party = this.parties.getParty(ctx.tenantId, id);
      if (!party) throw new HttpError(404, 'party not found');
      const reason = this.optString(body, 'reason');
      return this.gated('privacy.erase', ctx, { partyId: id }, () => this.erasePartyData(ctx.tenantId, id, reason), (receipt) => ({ status: 200, body: receipt }));
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

    // Revenue-management recommendations: prioritized, explainable opportunities
    // and risks over the demand signals + configured pricing rules.
    this.add('GET', '/revenue/insights', 'revenue.read', (ctx) => {
      const s = this.revenueSummary(ctx.tenantId);
      return {
        status: 200,
        body: {
          kpis: { occupancyPct: s.occupancyPct, adrCents: s.adrCents, revparCents: s.revparCents, revenueCents: s.revenueCents },
          insights: computeRevenueInsights({
            occupancyPct: s.occupancyPct, adrCents: s.adrCents, revparCents: s.revparCents,
            revenueCents: s.revenueCents, unitCount: s.unitCount, rules: this.revenue.listRules(ctx.tenantId),
          }),
        },
      };
    });

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

      // Agreements are event-sourced aggregates, not flat master data: each ok row
      // BOOKS a draft agreement through the same path as POST /agreements (guest and
      // unit codes resolve to master-data ids; the calendar guards double-booking).
      // A row whose codes don't resolve — or whose booking trips a constraint —
      // is reported as failed, never silently dropped.
      if (target === 'agreements') {
        const unitsByCode = new Map(this.masterData.units.list(ctx.tenantId).map((u) => [u.code, u]));
        const guestsByCode = new Map(this.masterData.guests.list(ctx.tenantId).map((g) => [g.code, g]));
        const currency = this.config.get(ctx.tenantId).currency;
        let created = 0;
        let skipped = 0;
        let failed = 0;
        const failures: Array<{ code: string; errors: string[] }> = [];
        for (const row of plan.rows) {
          if (row.status !== 'ok' || !row.record) continue;
          const r = row.record;
          const id = `agr-${r['code']}`;
          if (this.agreements.has(id)) { skipped++; continue; }
          const unit = unitsByCode.get(r['unitCode']!);
          const guest = guestsByCode.get(r['guestCode']!);
          const kind = r['kind'] as AgreementKind;
          const rateCents = Number(r['rateCents']);
          const problems: string[] = [];
          if (!unit) problems.push(`unknown unitCode '${r['unitCode']}'`);
          if (!guest) problems.push(`unknown guestCode '${r['guestCode']}'`);
          if (!['nightly', 'monthly', 'lease'].includes(kind)) problems.push(`invalid kind '${r['kind']}'`);
          if (!Number.isInteger(rateCents) || rateCents <= 0) problems.push(`invalid rateCents '${r['rateCents']}'`);
          if (problems.length) { failed++; failures.push({ code: r['code']!, errors: problems }); continue; }
          try {
            const a = Agreement.create({ id, tenantId: ctx.tenantId, guestId: guest!.id, unitId: unit!.id, kind, start: r['start']!, end: r['end']!, rateCents, currency, at: this.now() });
            this.calendar.hold({ id: `${id}-hold`, unitId: unit!.id, holderId: id, start: r['start']!, end: r['end']! }); // invariant 4
            this.agreements.set(id, { agreement: a, tenantId: ctx.tenantId });
            created++;
          } catch (e) {
            failed++;
            failures.push({ code: r['code']!, errors: [e instanceof Error ? e.message : 'booking failed'] });
          }
        }
        return { status: 201, body: { target, created, skipped, failed, failures, errorRows: plan.errorCount, total: plan.rows.length } };
      }

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
        if (target === 'units') {
          // A "type"/floorplan column auto-creates the unit type on first sight
          // and links every unit that names it — 200 rows → a few types.
          const link: { typeId?: string; propertyId?: string } = {};
          const typeCode = (row.record['type'] ?? '').trim();
          if (typeCode) {
            const typeId = `utype-${typeCode.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
            if (!this.masterData.unitTypes.get(ctx.tenantId, typeId)) {
              this.masterData.unitTypes.add({ id: typeId, tenantId: ctx.tenantId, code: typeCode, name: typeCode });
            }
            link.typeId = typeId;
          }
          // A "property"/community column auto-creates the property likewise.
          const propCode = (row.record['property'] ?? '').trim();
          if (propCode) {
            const propertyId = `prop-${propCode.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
            if (!this.masterData.properties.get(ctx.tenantId, propertyId)) {
              this.masterData.properties.add({ id: propertyId, tenantId: ctx.tenantId, code: propCode, name: propCode });
            }
            link.propertyId = propertyId;
          }
          this.masterData.units.add({ id, tenantId: ctx.tenantId, code, label: row.record['label'] ?? code, active: true, ...link });
        } else this.masterData.guests.add({ id, tenantId: ctx.tenantId, code, fullName: row.record['fullName']!, email: row.record['email'] });
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

    // --- rental applications + screening ----------------------------------
    this.add('GET', '/applications', 'application.read', (ctx) => ({ status: 200, body: { applications: this.applications.list(ctx.tenantId) } }));

    this.add('GET', '/applications/:id', 'application.read', (ctx, p) => {
      const a = this.ownedApplication(ctx, p['id']!);
      return { status: 200, body: a };
    });

    this.add('POST', '/applications', 'application.manage', (ctx, _p, body) => {
      const leadId = this.optString(body, 'leadId');
      if (leadId) this.ownedLead(ctx, leadId);
      const app = this.applications.submit({
        id: this.requireString(body, 'id'),
        tenantId: ctx.tenantId,
        applicantName: this.requireString(body, 'applicantName'),
        applicantEmail: this.optString(body, 'applicantEmail'),
        leadId,
        unitId: this.optString(body, 'unitId'),
        ...(typeof body['incomeCents'] === 'number' ? { incomeCents: body['incomeCents'] as number } : {}),
        submittedAt: this.now(),
      });
      this.applicationTenant.set(app.id, ctx.tenantId);
      // Advance the linked lead to 'applied' (best-effort — funnel visibility).
      if (leadId) { try { this.crm.advance(leadId, 'applied', this.now()); } catch { /* already past */ } }
      return { status: 201, body: app };
    });

    // Order a screening report. If the tenant has an active `screening`
    // integration, enqueue a credential-free connector command (the edge
    // resolves the vendor secret + calls TransUnion/Checkr/…); the result
    // returns via POST /integrations/:id/events or is recorded manually.
    this.add('POST', '/applications/:id/screen', 'application.manage', (ctx, p, _body) => {
      const app = this.ownedApplication(ctx, p['id']!);
      const integ = this.integrations.list(ctx.tenantId).find((i) => i.kind === 'screening' && i.status === 'active');
      if (integ) {
        this.connectorOutbox.enqueue({ id: `screen-${app.id}`, tenantId: ctx.tenantId, integrationId: integ.id, action: 'order_report', createdAt: this.now(), payload: { applicationId: app.id, applicantName: app.applicantName, applicantEmail: app.applicantEmail } });
      }
      return { status: 200, body: { ...this.applications.markScreening(app.id), ordered: !!integ } };
    });

    // Record a screening result (manual entry, or the inbound event handler routes here).
    this.add('POST', '/applications/:id/screening-result', 'application.manage', (ctx, p, body) => {
      this.ownedApplication(ctx, p['id']!);
      const result: ScreeningResult = {
        provider: this.optString(body, 'provider'),
        reference: this.optString(body, 'reference'),
        recommendation: (['approve', 'review', 'decline'] as const).find((r) => r === this.optString(body, 'recommendation')),
        ...(typeof body['creditScore'] === 'number' ? { creditScore: body['creditScore'] as number } : {}),
        completedAt: this.now(),
      };
      return { status: 200, body: this.applications.recordScreening(p['id']!, result) };
    });

    // Approve / deny — FCRA / Fair-Housing sensitive, so policy-gated + audited.
    // A denial REQUIRES an adverse-action reason and enqueues the notice.
    this.add('POST', '/applications/:id/decide', 'application.manage', (ctx, p, body) => {
      const app = this.ownedApplication(ctx, p['id']!);
      const decision = this.optString(body, 'decision');
      if (decision !== 'approve' && decision !== 'deny') throw new HttpError(400, "decision must be 'approve' or 'deny'");
      const reason = this.optString(body, 'reason') ?? '';
      if (decision === 'deny' && !reason) throw new HttpError(400, 'an adverse-action reason is required to deny');
      const at = this.now();
      return this.gated('application.decide', ctx, { applicationId: app.id, decision }, () => {
        if (decision === 'approve') {
          const r = this.applications.approve(app.id, at, ctx.actor);
          if (app.leadId) { try { this.crm.advance(app.leadId, 'approved', at); } catch { /* already past */ } }
          return r;
        }
        const r = this.applications.deny(app.id, at, ctx.actor, reason);
        if (app.leadId) { try { this.crm.lose(app.leadId, `application denied: ${reason}`, at); } catch { /* already closed */ } }
        // FCRA adverse-action notice to the applicant.
        if (app.applicantEmail) this.notify({ id: `notif-adverse-${app.id}`, tenantId: ctx.tenantId, channel: 'email', to: app.applicantEmail, kind: 'adverse_action', data: { applicationId: app.id, reason } });
        return r;
      }, (r) => ({ status: 200, body: r }));
    });

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
      return this.gated('esign.send', ctx, { id: env.id }, () => this.signatures.send(env.id, this.now(), this.optString(body, 'providerRef')), (e) => {
        // On send, email every signer a request to sign — best-effort, deduped per signer.
        for (const s of (e.signers ?? []) as Array<{ email: string }>) {
          this.notify({ id: `notif-esign-${e.id}-${s.email}`, tenantId: ctx.tenantId, channel: 'email', to: s.email, kind: 'esign_request', data: { envelopeId: e.id, documentName: e.documentName } });
        }
        return { status: 200, body: e };
      });
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
      // Segregation of duties: the human who INITIATED the escalated action cannot
      // also approve it. The RBAC gate already blocks the AI agent from approving
      // anything; this closes the parallel hole for human self-approval (a manager
      // rubber-stamping their own >R$5k payout). A different authorized approver
      // must sign off. (Escalations with no attributable initiator — e.g. a
      // scheduled sweep — carry the service/system actor and are unaffected.)
      const initiator = (item.ctx as { actor?: string }).actor;
      if (initiator && initiator === ctx.actor) {
        throw new HttpError(403, 'segregation of duties: the initiator of an escalated action cannot approve it — a different authorized approver must sign off');
      }
      // A REHYDRATED escalation (parked before a restart) no longer carries its
      // deferred operation — a closure cannot be persisted. Approving it records
      // the human decision; `executed:false` tells the operator the underlying
      // action must be RE-INITIATED (a regulated action re-escalates and the
      // fresh escalation carries a live thunk to approve).
      const executed = this.exceptions.hasThunk(p['id']!);
      const result = this.exceptions.approve(p['id']!, ctx.actor, this.now(), this.optString(body, 'note'));
      return { status: 200, body: { status: 'approved', executed, result: result ?? null } };
    });

    // Run the overdue-collections sweep. A scheduler (a Supabase pg_cron job or any
    // external cron) POSTs this on a cadence with the service role; a manager may
    // also run it on demand. For every open, past-due invoice it finds the highest
    // stage reached (src/collections.ts) and dispatches that stage's policy action:
    // remind / late_fee execute (a late fee posts a real receivable once), suspend /
    // evict ESCALATE for a human. Idempotent: each (invoice, stage) is recorded as a
    // message on a per-invoice collections thread, so re-running the sweep never
    // double-charges or re-escalates. `at` may be supplied (for testing/backfill).
    this.add('POST', '/collections/sweep', 'collections.run', (ctx, _p, body) => {
      const at = this.optString(body, 'at') ?? this.now();
      return { status: 200, body: this.runCollectionsSweep(ctx, at) };
    });

    // --- multi-GAAP revenue view (accrual vs cash) ------------------------
    // The same ledger, recognized under different bases: accrual books revenue
    // at invoice issue, cash proportionally to collection. Read-only projection.
    this.add('GET', '/gaap/:basis', 'reports.read', (ctx, p) => {
      const basis = p['basis'] === 'cash' ? 'cash' : p['basis'] === 'accrual' ? 'accrual' : null;
      if (!basis) throw new HttpError(400, "basis must be 'accrual' or 'cash'");
      const agIds = new Set([...this.agreements.values()].filter((e) => e.tenantId === ctx.tenantId).map((e) => e.agreement.id));
      const lines = this.ledger.allLines.filter((l) => (l.agreementId != null && agIds.has(l.agreementId)) || l.tenantId === ctx.tenantId);
      const view = gaapViewFromLines(lines, basis);
      return { status: 200, body: { basis, totalRevenueCents: view.totalRevenueCents, revenue: Object.fromEntries(view.revenue) } };
    });

    // --- period close (month-end posting locks) ---------------------------
    this.add('GET', '/periods', 'ledger.read', (ctx) => ({ status: 200, body: { periods: this.periodLock.list(ctx.tenantId) } }));

    // Close a period — no journal entry may post into it afterward. Routine
    // finance action (RBAC only). Recorded in the tenant action log via gated().
    this.add('POST', '/periods/close', 'period.manage', (ctx, _p, body) => {
      const period = this.requireString(body, 'period');
      const at = this.now();
      return this.gated('ledger.close_period', ctx, { period }, () => this.periodLock.close(ctx.tenantId, period, at, ctx.actor), (r) => ({ status: 200, body: r }));
    });

    // Re-open a closed period — a regulated RESTATEMENT, so it ESCALATES (202)
    // for a human, then runs only on approve. Books a fund already received
    // can't be silently reworked.
    this.add('POST', '/periods/reopen', 'period.manage', (ctx, _p, body) => {
      const period = this.requireString(body, 'period');
      const at = this.now();
      return this.gated('ledger.reopen_period', ctx, { period }, () => this.periodLock.reopen(ctx.tenantId, period, at, ctx.actor), (r) => ({ status: 200, body: r }));
    });

    // --- billing / reporting ----------------------------------------------
    this.add('GET', '/billing/subscription', 'subscription.read', (ctx) => ({
      status: 200,
      body: meterSubscription(this.masterData.units.list(ctx.tenantId).length, this.plan),
    }));

    // --- self-service reporting + automated insights ----------------------
    // The report CATALOG (what can be pulled), each report over a window, and the
    // insight feed (prioritized, explainable findings). Broadly readable (reports.read).
    this.add('GET', '/reports/catalog', 'reports.read', () => ({ status: 200, body: { reports: REPORT_CATALOG } }));

    this.add('GET', '/reports/insights', 'reports.read', (ctx, _p, body) => {
      const w = this.reportWindow(this.optString(body, 'from'), this.optString(body, 'to'));
      return { status: 200, body: { window: w, insights: computeInsights(this.reportingInput(ctx.tenantId, w.from, w.to)) } };
    });

    // Self-service report BUILDER: the catalog of pickable sources/dimensions/
    // measures/filters, and a POST that runs a user-composed spec into a grouped,
    // chart-ready report. (Registered before /reports/:key so 'sources' / 'build'
    // aren't swallowed by the :key param.)
    this.add('GET', '/reports/build/sources', 'reports.read', () => ({ status: 200, body: { sources: dataSources() } }));

    this.add('POST', '/reports/build', 'reports.read', (ctx, _p, body) => {
      const w = this.reportWindow(this.optString(body, 'from'), this.optString(body, 'to'));
      const spec: CustomReportSpec = {
        source: this.requireString(body, 'source'),
        dimension: this.requireString(body, 'dimension'),
        measure: this.optString(body, 'measure'),
        aggregate: this.optString(body, 'aggregate') as CustomReportSpec['aggregate'],
        chart: this.optString(body, 'chart') as CustomReportSpec['chart'],
        filterKey: this.optString(body, 'filterKey'),
        filterValue: this.optString(body, 'filterValue'),
        limit: typeof body['limit'] === 'number' ? (body['limit'] as number) : undefined,
      };
      const report = buildCustomReport(spec, this.reportingInput(ctx.tenantId, w.from, w.to));
      if (!report) throw new HttpError(400, 'invalid report spec (unknown source, dimension, or measure)');
      return { status: 200, body: { report } };
    });

    this.add('GET', '/reports/:key', 'reports.read', (ctx, p, body) => {
      const w = this.reportWindow(this.optString(body, 'from'), this.optString(body, 'to'));
      // ?propertyId=<id> scopes operational reports to one community.
      const propertyId = this.optString(body, 'propertyId');
      const input = this.reportingInput(ctx.tenantId, w.from, w.to, propertyId);
      const report = buildReport(p['key']!, input);
      if (!report) throw new HttpError(404, `unknown report '${p['key']}'`);
      // Every report ships with the insight feed so a dashboard shows both at once.
      return { status: 200, body: { report, insights: computeInsights(input) } };
    });

    // --- access advisor (AI role/permission recommendation) ---------------
    // Turn a plain-language description of what a person does into a least-privilege
    // access recommendation (capabilities → permissions, closest built-in role or a
    // proposed custom role, rationale + risk flags). Advisory only — role.read.
    this.add('POST', '/access/advise', 'role.read', (_ctx, _p, body) => {
      const description = this.requireString(body, 'description');
      return { status: 200, body: recommendAccess(description, this.optString(body, 'roleId')) };
    });

    // --- sample data (demo seeder) ----------------------------------------
    // Load a realistic mixed-portfolio sample into an empty tenant so every
    // surface is populated at once. Idempotent (the `demo-` marker unit guards
    // re-seeding) and gated by masterdata.manage — the same permission that
    // governs bulk master-data import. All records book through the normal
    // kernel path, so seeded data honors the money/inventory invariants.
    this.add('POST', '/demo/seed', 'masterdata.manage', (ctx, _p, body) => {
      const at = this.optString(body, 'at') ?? this.now();
      return { status: 201, body: this.seedDemoData(ctx.tenantId, at) };
    });

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

  /** Gather a tenant's data into the reporting engine's input for a window. */
  private reportingInput(tenantId: string, from: string, to: string, propertyId?: string): ReportingInput {
    const entries = [...this.agreements.values()].filter((e) => e.tenantId === tenantId);
    const agIds = new Set(entries.map((e) => e.agreement.id));
    const invoices = this.billing.allInvoices().filter((i) => i.tenantId === tenantId);
    const invIds = new Set(invoices.map((i) => i.id));
    const bills = this.payables.allBills().filter((b) => b.tenantId === tenantId);
    const billIds = new Set(bills.map((b) => b.id));
    // Resolve the human behind each agreement: the resident party link wins,
    // then the payer, then the master-data guest — so the rent roll and the
    // delinquency report name people, not ids.
    const residentFor = (agreementId: string, guestId: string): string | undefined => {
      const link = this.parties.partiesFor(agreementId, 'resident')[0] ?? this.parties.partiesFor(agreementId, 'financial_responsible')[0];
      if (link) {
        const p = this.parties.getParty(tenantId, link.partyId);
        if (p) return p.displayName;
      }
      // Prefer a master-data guest's name; else fall back to the raw guestId so
      // an API-/CSV-booked agreement (no party link, no master-data guest) still
      // shows an identifier on the rent roll instead of a blank "—".
      return this.masterData.guests.get(tenantId, guestId)?.fullName ?? (guestId || undefined);
    };
    const full: ReportingInput = {
      now: this.now(),
      from,
      to,
      currency: this.config.get(tenantId).currency,
      units: this.masterData.units.list(tenantId).map((u) => {
        const t = u.typeId ? this.masterData.unitTypes.get(tenantId, u.typeId) : null;
        const pr = u.propertyId ? this.masterData.properties.get(tenantId, u.propertyId) : null;
        return { id: u.id, label: u.label, active: u.active !== false, ...(t ? { typeName: t.name } : {}), ...(pr ? { propertyId: pr.id, propertyName: pr.name } : {}) };
      }),
      properties: this.masterData.properties.list(tenantId).map((pr) => {
        const owner = pr.entityId ? this.entities.getEntity(tenantId, pr.entityId) : null;
        return { id: pr.id, name: pr.name, ...(owner ? { entityName: owner.name } : {}) };
      }),
      agreements: entries.map((e) => {
        const rn = residentFor(e.agreement.id, e.agreement.guestId);
        return { id: e.agreement.id, kind: e.agreement.kind, status: e.agreement.status, unitId: e.agreement.currentUnitId, start: e.agreement.period.start, end: e.agreement.period.end, rateCents: e.agreement.rateCents, ...(rn ? { residentName: rn } : {}) };
      }),
      invoices: invoices.map((i) => ({ id: i.id, agreementId: i.agreementId, issuedAt: i.issuedAt, dueAt: i.dueAt, totalCents: i.totalCents, paidCents: i.paidCents, status: i.status })),
      payments: this.payments.all().filter((p) => invIds.has(p.invoiceId)).map((p) => ({ id: p.id, invoiceId: p.invoiceId, amountCents: p.amountCents, receivedAt: p.receivedAt, status: p.status })),
      deposits: this.deposits.all().filter((d) => agIds.has(d.agreementId)).map((d) => ({ id: d.id, agreementId: d.agreementId, amountCents: d.amountCents, status: d.status, heldAt: d.heldAt, refundedCents: d.refundedCents })),
      bills: bills.map((b) => ({ id: b.id, payeeId: b.payeeId, totalCents: b.totalCents, paidCents: b.paidCents, status: b.status, issuedAt: b.issuedAt, dueAt: b.dueAt })),
      apPayments: this.payables.allPayments().filter((p) => billIds.has(p.billId)).map((p) => ({ id: p.id, billId: p.billId, amountCents: p.amountCents, paidAt: p.paidAt, status: p.status })),
      leads: this.crm.list(tenantId).map((l) => ({ id: l.id, stage: l.stage, estValueCents: l.estValueCents, createdAt: l.createdAt, updatedAt: l.updatedAt, ...(l.source ? { source: l.source } : {}) })),
      workOrders: this.maintenance.all().filter((w) => w.tenantId === tenantId).map((w) => ({ id: w.id, status: w.status, priority: w.priority, openedAt: w.openedAt, title: w.title })),
      holds: this.calendar.allHolds().filter((h) => agIds.has(h.holderId)).map((h) => ({ unitId: h.unitId, start: h.start, end: h.end, status: h.status })),
      ledgerBalanced: this.trialBalance(tenantId).balanced,
      // Tenant-scoped GL lines (same predicate as the trial balance) — the raw
      // material for the income statement / general-ledger reports + builder.
      ledgerLines: this.ledger.allLines
        .filter((l) => (l.agreementId != null && agIds.has(l.agreementId)) || l.tenantId === tenantId)
        .map((l) => ({ account: l.account, debitCents: l.debitCents, creditCents: l.creditCents, postedAt: l.postedAt, ...(l.entityId ? { entityId: l.entityId } : {}), ...(l.propertyId ? { propertyId: l.propertyId } : {}) })),
    };
    if (!propertyId) return full;
    // Per-property scope: restrict to units of this property and the agreements
    // (and their invoices/payments/deposits/holds) on those units. Operational
    // reports (rent roll, occupancy, box score, vacancy, delinquency, lease
    // expirations) become per-community. (Financial statements over ledgerLines
    // gain per-property scope in the entity/property journal-line stamp.)
    const unitIds = new Set(full.units.filter((u) => u.propertyId === propertyId).map((u) => u.id));
    const propAgIds = new Set(full.agreements.filter((a) => unitIds.has(a.unitId)).map((a) => a.id));
    const propInvIds = new Set(full.invoices.filter((i) => propAgIds.has(i.agreementId)).map((i) => i.id));
    return {
      ...full,
      units: full.units.filter((u) => unitIds.has(u.id)),
      agreements: full.agreements.filter((a) => propAgIds.has(a.id)),
      invoices: full.invoices.filter((i) => propAgIds.has(i.agreementId)),
      payments: full.payments.filter((p) => propInvIds.has(p.invoiceId)),
      deposits: full.deposits.filter((d) => propAgIds.has(d.agreementId)),
      holds: full.holds.filter((h) => unitIds.has(h.unitId)),
      // Financial statements now scope too: keep only lines stamped for this property.
      ledgerLines: (full.ledgerLines ?? []).filter((l) => l.propertyId === propertyId),
    };
  }

  private inquirySeq = 0;

  /** Gather a tenant's PUBLIC (marketing-only) booking-site slice: bookable units,
   *  their calendar holds, past agreement rates (for a per-unit base), the primary
   *  pricing rule. Returns null if the tenant has no bookable inventory. */
  private bookingSiteInput(tenantId: string): BookingSiteInput | null {
    const units = this.masterData.units.list(tenantId);
    if (units.length === 0) return null;
    const entries = [...this.agreements.values()].filter((e) => e.tenantId === tenantId);
    const agIds = new Set(entries.map((e) => e.agreement.id));
    const cfg = this.config.get(tenantId);
    return {
      tenantId,
      displayName: cfg.displayName,
      currency: cfg.currency,
      units: units.map((u) => ({ id: u.id, label: u.label, active: u.active !== false, ...(u.typeId ? { typeId: u.typeId } : {}) })),
      unitTypes: this.masterData.unitTypes.list(tenantId).map((t) => ({
        id: t.id, code: t.code, name: t.name,
        ...(t.bedrooms !== undefined ? { bedrooms: t.bedrooms } : {}),
        ...(t.bathrooms !== undefined ? { bathrooms: t.bathrooms } : {}),
        ...(t.maxGuests !== undefined ? { maxGuests: t.maxGuests } : {}),
        ...(t.areaSqm !== undefined ? { areaSqm: t.areaSqm } : {}),
        ...(t.baseRentCents !== undefined ? { baseRentCents: t.baseRentCents } : {}),
        ...(t.description !== undefined ? { description: t.description } : {}),
      })),
      holds: this.calendar.allHolds().filter((h) => agIds.has(h.holderId)).map((h) => ({ unitId: h.unitId, start: h.start, end: h.end, status: h.status })),
      agreements: entries.map((e) => ({ unitId: e.agreement.currentUnitId, rateCents: e.agreement.rateCents, start: e.agreement.period.start })),
      rule: this.revenue.listRules(tenantId)[0],
      brand: { color: cfg.brandColor, logoDataUrl: cfg.logoDataUrl, tagline: cfg.tagline, locale: cfg.locale },
      content: this.siteContent.get(tenantId),
    };
  }

  /** The public booking-website surface (pre-auth). Returns null for an unknown
   *  route so the caller falls through to the normal authenticated router. */
  private bookingSiteRoute(method: string, tenant: string, action: string | undefined, body: Record<string, unknown>): ApiResponse | null {
    const inp = this.bookingSiteInput(tenant);
    // config (listing) — GET /site/:tenant/config[?template=<id>&radius=&font=&hero=&cards=]
    // ?template= (+ optional fine-tune params) is a PREVIEW override: the listing
    // is themed with that template + adjustments (brand accent still applied)
    // WITHOUT touching the saved choice, so the operator can eyeball every design
    // on their real site before picking. Invalid values are dropped by sanitize.
    if (method === 'GET' && action === 'config') {
      if (!inp) return { status: 404, body: { error: 'no published inventory for this site' } };
      const listing = siteListing(inp);
      const preview = this.optString(body, 'template');
      if (preview && isKnownTemplate(preview)) {
        const opts = sanitizeSiteContent({
          template: preview,
          templateOptions: {
            radius: this.optString(body, 'radius'),
            font: this.optString(body, 'font'),
            hero: this.optString(body, 'hero'),
            cards: this.optString(body, 'cards'),
          },
        }).templateOptions;
        listing.theme = resolveTheme(preview, opts, inp?.brand?.color);
        listing.previewTemplate = preview;
      }
      return { status: 200, body: listing };
    }
    // availability — POST /site/:tenant/availability {from,to}
    if (method === 'POST' && action === 'availability') {
      if (!inp) return { status: 404, body: { error: 'no published inventory for this site' } };
      const from = this.optString(body, 'from');
      const to = this.optString(body, 'to');
      if (!from || !to) return { status: 400, body: { error: 'from and to dates are required' } };
      try {
        return { status: 200, body: { from, to, units: checkAvailability(inp, from, to) } };
      } catch (e) {
        return { status: 400, body: { error: e instanceof Error ? e.message : 'bad request' } };
      }
    }
    // booking request — POST /site/:tenant/inquire {unitId,from,to,name,email,message?}
    if (method === 'POST' && action === 'inquire') {
      if (!inp) return { status: 404, body: { error: 'no published inventory for this site' } };
      const unitId = this.optString(body, 'unitId');
      const from = this.optString(body, 'from');
      const to = this.optString(body, 'to');
      const name = (this.optString(body, 'name') ?? '').trim();
      const email = (this.optString(body, 'email') ?? '').trim();
      if (!name || !email) return { status: 400, body: { error: 'name and email are required' } };
      if (!unitId || !from || !to || !isValidDate(from) || !isValidDate(to)) return { status: 400, body: { error: 'a unit and valid dates are required' } };
      const unit = this.masterData.units.get(tenant, unitId);
      if (!unit) return { status: 404, body: { error: 'unit not found' } };
      // Price the request so the lead carries an estimated value.
      let estValueCents = 0;
      try { estValueCents = checkAvailability(inp, from, to).find((u) => u.unitId === unitId)?.totalCents ?? 0; } catch { /* leave 0 */ }
      const at = this.now();
      const id = `web-inq-${at.replace(/[^0-9]/g, '')}-${this.inquirySeq++}`;
      this.crm.createLead({
        id, tenantId: tenant, name: `Website: ${name} — ${unit.label} (${from}→${to})`,
        source: 'website', estValueCents, createdAt: at,
      });
      return { status: 201, body: { ok: true, reference: id, message: 'Thanks — your request was received. The host will be in touch shortly.' } };
    }
    return null; // unknown /site route → fall through
  }

  /** Default reporting window: [today-30d, tomorrow) unless from/to are given. */
  private reportWindow(from?: string, to?: string): { from: string; to: string } {
    const nowMs = Date.parse(this.now());
    const day = 86_400_000;
    const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
    return { from: from ?? iso(nowMs - 30 * day), to: to ?? iso(nowMs + day) };
  }

  /**
   * Seed a tenant with the Ilhabela mixed-portfolio sample. Idempotent: if the
   * marker unit is already present it returns {seeded:false} and touches nothing.
   * Records book through the normal kernel stores (Agreement.create, Billing,
   * Payables, Deposits, …) so seeded data honors every invariant — this is the
   * same discipline as the onboarding importer, governed by masterdata.manage.
   */
  private seedDemoData(tenantId: string, at: string): {
    seeded: boolean;
    counts?: Record<string, number>;
  } {
    if (this.masterData.units.get(tenantId, DEMO_MARKER_UNIT_ID)) return { seeded: false };
    const w = buildDemoWorld(tenantId, at);
    const currency = this.config.get(tenantId).currency;
    const unitId = (code: string) => `demo-unit-${code}`;
    const guestId = (code: string) => `demo-guest-${code}`;
    let payments = 0;
    let billPayments = 0;

    const propId = (code: string) => `demo-prop-${code}`;
    for (const pr of w.properties) this.masterData.properties.add({ id: propId(pr.code), tenantId, code: pr.code, name: pr.name, ...(pr.address ? { address: pr.address } : {}) });
    for (const u of w.units) this.masterData.units.add({ id: unitId(u.code), tenantId, code: u.code, label: u.label, active: u.active, ...(u.propertyCode ? { propertyId: propId(u.propertyCode) } : {}) });
    for (const g of w.guests) this.masterData.guests.add({ id: guestId(g.code), tenantId, code: g.code, fullName: g.fullName, email: g.email });
    for (const p of w.parties) this.parties.addParty({ id: p.id, tenantId, kind: p.kind, displayName: p.displayName, legalName: p.legalName, taxId: p.taxId, email: p.email, phone: p.phone, attributes: p.attributes });
    for (const pr of w.pricingRules) this.revenue.setRule({ id: pr.id, tenantId, name: pr.name, baseCents: pr.baseCents, minCents: pr.minCents, maxCents: pr.maxCents, weekendFactorBps: pr.weekendFactorBps, occupancyTiers: pr.occupancyTiers, losDiscounts: pr.losDiscounts });

    for (const a of w.agreements) {
      const ag = Agreement.create({ id: a.id, tenantId, guestId: guestId(a.guestCode), unitId: unitId(a.unitCode), kind: a.kind, start: a.start, end: a.end, rateCents: a.rateCents, currency, at });
      this.calendar.hold({ id: `${a.id}-hold`, unitId: unitId(a.unitCode), holderId: a.id, start: a.start, end: a.end }); // invariant 4
      this.agreements.set(a.id, { agreement: ag, tenantId });
      if (a.activate) ag.activate(a.start);
      if (a.moveIn) ag.moveIn(a.start);
      // Party role links (resident / financial_responsible / guarantor).
      if (a.residentPartyId) this.parties.assign({ agreementId: a.id, partyId: a.residentPartyId, role: 'resident', from: a.start });
      if (a.payerPartyId) this.parties.assign({ agreementId: a.id, partyId: a.payerPartyId, role: 'financial_responsible', from: a.start });
      if (a.guarantorPartyId) this.parties.assign({ agreementId: a.id, partyId: a.guarantorPartyId, role: 'guarantor', from: a.start });
    }

    for (const inv of w.invoices) {
      const billToPartyId = this.parties.billTo(inv.agreementId) ?? undefined;
      const propertyId = this.propertyForAgreement(tenantId, inv.agreementId);
      this.billing.issue({ id: inv.id, agreementId: inv.agreementId, tenantId, issuedAt: inv.issuedAt, dueAt: inv.dueAt, currency, lines: inv.lines, billToPartyId, propertyId });
      this.invoiceTenant.set(inv.id, tenantId);
      if (inv.payCents && inv.payCents > 0) {
        this.payments.record({ id: `pay-${inv.id}`, invoiceId: inv.id, amountCents: inv.payCents, method: inv.payMethod ?? 'pix', receivedAt: inv.paidAt ?? inv.issuedAt, propertyId });
        payments++;
      }
    }

    for (const dep of w.deposits) { this.deposits.hold({ id: dep.id, agreementId: dep.agreementId, amountCents: dep.amountCents, currency, heldAt: dep.heldAt }); this.depositTenant.set(dep.id, tenantId); }

    for (const b of w.bills) {
      this.payables.issue({ id: b.id, tenantId, payeeId: b.payeeId, issuedAt: b.issuedAt, dueAt: b.dueAt, currency, lines: b.lines, memo: b.memo });
      if (b.payCents && b.payCents > 0) { this.payables.pay({ id: `appay-${b.id}`, billId: b.id, amountCents: b.payCents, method: b.payMethod ?? 'pix', paidAt: b.paidAt ?? b.issuedAt }); billPayments++; }
    }

    for (const wo of w.workOrders) {
      this.maintenance.open({ id: wo.id, tenantId, title: wo.title, description: wo.description, category: wo.category, priority: wo.priority, requestedByPartyId: wo.requestedByPartyId, openedAt: wo.openedAt });
      if (wo.assignVendorPartyId) this.maintenance.assign(wo.id, wo.assignVendorPartyId, wo.startedAt ?? wo.openedAt);
      if (wo.startedAt) this.maintenance.start(wo.id, wo.startedAt);
      if (wo.completedAt) this.maintenance.complete(wo.id, wo.completedAt, { resolution: wo.resolution });
    }

    for (const l of w.leads) {
      this.crm.createLead({ id: l.id, tenantId, name: l.name, source: l.source, estValueCents: l.estValueCents, createdAt: l.createdAt });
      // 'lost' leaves the pipeline via lose(); the rest advance forward.
      for (const stage of l.advanceTo ?? []) {
        if (stage === 'lost') this.crm.lose(l.id, 'not converted', l.createdAt);
        else this.crm.advance(l.id, stage, l.createdAt);
      }
    }

    return {
      seeded: true,
      counts: {
        units: w.units.length, guests: w.guests.length, parties: w.parties.length,
        pricingRules: w.pricingRules.length, agreements: w.agreements.length,
        invoices: w.invoices.length, payments, deposits: w.deposits.length,
        bills: w.bills.length, billPayments, workOrders: w.workOrders.length,
        leads: w.leads.length,
      },
    };
  }

  private trialBalance(tenantId: string) {
    const ids = new Set([...this.agreements.values()].filter((e) => e.tenantId === tenantId).map((e) => e.agreement.id));
    const balances: Record<string, number> = {};
    for (const line of this.ledger.allLines) {
      // A line is this tenant's through its agreement OR — for agreement-less
      // accounts-payable entries — through its own tenant tag; omitting the
      // latter silently understated cash/expenses while still netting to zero.
      const mine = (line.agreementId != null && ids.has(line.agreementId)) || line.tenantId === tenantId;
      if (!mine) continue;
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
      tenants: [{ id: tenantId, name: cfg.displayName ?? tenantId, displayName: cfg.displayName, locale: cfg.locale, currency: cfg.currency, timezone: cfg.timezone, businessStructure: cfg.businessStructure, country: cfg.country, jurisdiction: cfg.jurisdiction, brandColor: cfg.brandColor, logoDataUrl: cfg.logoDataUrl, tagline: cfg.tagline, ...(this.siteContent.has(tenantId) ? { siteContent: this.siteContent.get(tenantId) as Record<string, unknown> } : {}) }],
      units: this.masterData.units.list(tenantId).map((u) => ({ id: u.id, tenantId, label: u.label, code: u.code, active: u.active, ...(u.typeId ? { typeId: u.typeId } : {}), ...(u.propertyId ? { propertyId: u.propertyId } : {}) })),
      properties: this.masterData.properties.list(tenantId).map((pr) => ({
        id: pr.id, tenantId, code: pr.code, name: pr.name,
        ...(pr.address !== undefined ? { address: pr.address } : {}),
        ...(pr.entityId !== undefined ? { entityId: pr.entityId } : {}),
      })),
      unitTypes: this.masterData.unitTypes.list(tenantId).map((t) => ({
        id: t.id, tenantId, code: t.code, name: t.name,
        ...(t.bedrooms !== undefined ? { bedrooms: t.bedrooms } : {}),
        ...(t.bathrooms !== undefined ? { bathrooms: t.bathrooms } : {}),
        ...(t.maxGuests !== undefined ? { maxGuests: t.maxGuests } : {}),
        ...(t.areaSqm !== undefined ? { areaSqm: t.areaSqm } : {}),
        ...(t.baseRentCents !== undefined ? { baseRentCents: t.baseRentCents } : {}),
        ...(t.description !== undefined ? { description: t.description } : {}),
      })),
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
      // Tenant-scoped journal lines are append-ordered; slice the tail past the
      // mark. A line belongs to the tenant through its agreement OR — for the
      // agreement-less accounts-payable entries — through its own tenant tag.
      journalLines: this.ledger.allLines
        .filter((l) => (l.agreementId != null && agreementIds.has(l.agreementId)) || l.tenantId === tenantId)
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
      // Policy escalations (pending + resolved) — always sent (upserted for the
      // status change) so a restart never silently drops a parked human decision.
      exceptions: this.exceptions.all().filter((i) => (i.ctx as { tenantId?: string }).tenantId === tenantId),
      periodLocks: this.periodLock.list(tenantId),
      bankAccounts: this.bankAccounts.list(tenantId),
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
      applications: this.applications.list(tenantId),
      // --- full persistence: platform users, custom roles, e-sign, connectors --
      users: this.masterData.users.list(tenantId),
      customRoles: this.roles.customRolesFor(tenantId).map((r) => ({ tenantId, roleId: r.id, name: r.name, description: r.description, permissions: r.permissions === '*' ? [...this.roles.permissionsFor(tenantId, r.id)] : (r.permissions as readonly string[]) })),
      integrations: this.integrations.list(tenantId),
      connectorCommands: this.connectorOutbox.list(tenantId),
      notifications: this.notifications.list(tenantId),
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
        ...(t.brandColor ? { brandColor: t.brandColor } : {}), ...(t.logoDataUrl ? { logoDataUrl: t.logoDataUrl } : {}), ...(t.tagline ? { tagline: t.tagline } : {}),
      });
      if (t.siteContent) this.siteContent.set(t.id, t.siteContent);
    }
    // Master data (unit code/active/type + guest code/email are all persisted now).
    for (const t of world.unitTypes ?? []) this.masterData.unitTypes.add({
      id: t.id, tenantId: t.tenantId, code: t.code, name: t.name,
      ...(t.bedrooms !== undefined ? { bedrooms: t.bedrooms } : {}),
      ...(t.bathrooms !== undefined ? { bathrooms: t.bathrooms } : {}),
      ...(t.maxGuests !== undefined ? { maxGuests: t.maxGuests } : {}),
      ...(t.areaSqm !== undefined ? { areaSqm: t.areaSqm } : {}),
      ...(t.baseRentCents !== undefined ? { baseRentCents: t.baseRentCents } : {}),
      ...(t.description !== undefined ? { description: t.description } : {}),
    });
    for (const pr of world.properties ?? []) this.masterData.properties.add({
      id: pr.id, tenantId: pr.tenantId, code: pr.code, name: pr.name,
      ...(pr.address !== undefined ? { address: pr.address } : {}),
      ...(pr.entityId !== undefined ? { entityId: pr.entityId } : {}),
    });
    for (const u of world.units) this.masterData.units.add({ id: u.id, tenantId: u.tenantId, code: u.code ?? u.id, label: u.label, active: u.active ?? true, ...(u.typeId ? { typeId: u.typeId } : {}), ...(u.propertyId ? { propertyId: u.propertyId } : {}) });
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
    this.applications.hydrate((world.applications ?? []) as never);
    for (const a of world.applications ?? []) this.applicationTenant.set(a.id, a.tenantId);
    this.signatures.hydrate((world.signatureEnvelopes ?? []) as never);
    this.integrations.hydrate((world.integrations ?? []) as never);
    this.connectorOutbox.hydrate((world.connectorCommands ?? []) as never);
    this.notifications.hydrate((world.notifications ?? []) as never);
    this.exceptions.hydrate((world.exceptions ?? []) as never);
    this.periodLock.hydrate((world.periodLocks ?? []) as never);
    this.bankAccounts.hydrate((world.bankAccounts ?? []) as never);
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
      // MUST use the same predicate as snapshotWorld's journalLines filter,
      // or the incremental slice would drift (AP lines count here too).
      journalLines: this.ledger.allLines.filter((l) => (l.agreementId != null && agreementIds.has(l.agreementId)) || l.tenantId === tenantId).length,
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
    try {
      return { status: 200, body: await this.flushWorld(ctx.tenantId) };
    } catch (e) {
      // EdgePersistError carries the function's HTTP status + body; surface it.
      const status = (e as { status?: number }).status ?? 502;
      const detail = (e as { body?: unknown }).body ?? (e instanceof Error ? e.message : String(e));
      return { status, body: { error: 'persist_failed', detail } };
    }
  }

  /**
   * Server-internal flush (no auth gate — the server owns it): send the tenant's
   * incremental delta to the durable backend and advance the high-water mark only
   * on success (so a failed flush safely re-sends). The lifecycle wrapper calls this
   * after writes; /persist calls it behind the persistence.run gate. Throws if no
   * backend is configured (the caller decides how loud to be).
   */
  async flushWorld(tenantId: string): Promise<Record<string, unknown>> {
    if (!this.persistence) throw new HttpError(501, 'no_persistence_backend');
    // SERIALIZE per tenant: two overlapping flushes (a debounced write-triggered
    // one racing the periodic safety flush) would both snapshot the same delta
    // before either advances the mark, double-sending the append-only streams
    // (journal_line/agreement_event/action_log have no natural key, so the
    // duplicates would stick and double balances on the next boot). Each flush
    // therefore queues behind the tenant's in-flight one and re-reads the mark
    // only once it is its turn.
    const prev = this.flushInFlight.get(tenantId) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(() => this.flushWorldSerial(tenantId));
    this.flushInFlight.set(tenantId, run.then(() => undefined, () => undefined));
    return run;
  }

  private async flushWorldSerial(tenantId: string): Promise<Record<string, unknown>> {
    const mark = this.flushMarks.get(tenantId);
    const world = this.snapshotWorld(tenantId, mark);
    const nextMark = this.highWaterMark(tenantId);
    const delta = {
      events: world.agreements.reduce((n, a) => n + a.events.length, 0),
      journalLines: world.journalLines.length,
      actionLog: world.actionLog.length,
      invoices: world.invoices.length,
    };
    const result = await this.persistence!.persist(world);
    this.flushMarks.set(tenantId, nextMark); // advance only after success
    return { ...result, delta, incremental: mark !== undefined };
  }

  /**
   * Cold-start boot: reconstitute in-memory state from durable storage. For each
   * tenant the reader loads a WorldData (the inverse of the write projection) and
   * rehydrate() folds it in. After boot the flush marks are set to each tenant's
   * high-water mark, so the first post-boot flush sends only NEW rows (no re-send of
   * everything just loaded). Idempotent-ish: intended to run ONCE on a fresh process.
   */
  async boot(reader: WorldReader, tenantIds: readonly string[]): Promise<void> {
    for (const tenantId of tenantIds) {
      const world = await reader.loadWorld(tenantId);
      this.rehydrate(world);
      this.flushMarks.set(tenantId, this.highWaterMark(tenantId));
    }
  }

  /** Resolve a bearer to its AuthContext (server lifecycle needs the tenant to flush). */
  identify(bearer: string | undefined): AuthContext | null {
    return this.auth.authenticate(bearer);
  }
}

/** The read side the boot lifecycle consumes — the inverse of the write backend.
 *  Repositories(tenantId, executor).loadWorld() implements this per tenant. */
export interface WorldReader {
  loadWorld(tenantId: string): Promise<WorldData>;
}
