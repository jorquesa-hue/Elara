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
import { meterSubscription, type SubscriptionPlan } from '../subscription.ts';
import {
  ConfigStore,
  SUPPORTED_LOCALES,
  SUPPORTED_CURRENCIES,
  BUSINESS_STRUCTURES,
  type TenantConfig,
} from '../config.ts';
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
      { actor: ctx.actor, tenantId: ctx.tenantId, ...extra },
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
    return entry.agreement;
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
        },
      },
    }));

    // Setup-time: change language, currency, timezone, business structure.
    this.add('PUT', '/config', 'config.manage', (ctx, _p, body) => {
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
      return { status: 200, body: this.billing.get(p['id']!) };
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
      return this.gated('deposit.refund', ctx, { depositId: id }, () => this.deposits.refund(id, at, deductions), (d) => ({ status: 200, body: d }));
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
      return this.gated(
        'bill.issue',
        ctx,
        { payeeId },
        () => this.payables.issue({ id, tenantId: ctx.tenantId, payeeId, entityId, issuedAt, dueAt, currency, lines, memo: this.optString(body, 'memo') }),
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

    return {
      tenants: [{ id: tenantId, name: cfg.displayName ?? tenantId }],
      units: this.masterData.units.list(tenantId).map((u) => ({ id: u.id, tenantId, label: u.label })),
      guests: this.masterData.guests.list(tenantId).map((g) => ({ id: g.id, tenantId, fullName: g.fullName })),
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
      actionLog: this.runtime.actionLog().slice(since?.actionLog ?? 0),
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
    };
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
      actionLog: this.runtime.actionLog().length,
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
