// The Public API is the only API (invariant 3). Its core is a transport-agnostic
// router: dispatch(request) -> response. src/api/http.ts binds it to node:http.
//
// Two rules hold for every request:
//   - Auth first: no valid bearer -> 401; every resource is tenant-scoped, and
//     cross-tenant reads return 404 (existence is never leaked).
//   - Policy before effect: every MUTATION runs through AgentRuntime.execute so
//     PolicyEnvelope.decide() precedes the operation (invariant 2). allow ->
//     2xx, deny -> 403, escalate -> 202 { exceptionId }.

import { Ledger } from '../ledger.ts';
import { Agreement, Calendar, DoubleInventoryError, type AgreementKind } from '../agreement.ts';
import { PolicyEnvelope } from '../policy-envelope.ts';
import { ExceptionQueue } from '../exception-queue.ts';
import { AgentRuntime, type ToolCallResult } from '../agent-runtime.ts';
import { Billing, type InvoiceLine } from '../billing.ts';
import { Payments, type PaymentMethod } from '../payments.ts';
import { Deposits, type Deduction } from '../deposits.ts';
import { meterSubscription, type SubscriptionPlan } from '../subscription.ts';
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

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// Domain errors -> HTTP status. Unknown domain errors are 400 (client-caused),
// not 500 (which is reserved for genuine bugs).
function statusForError(e: unknown): number {
  if (e instanceof HttpError) return e.status;
  if (e instanceof DoubleInventoryError) return 409;
  const name = e instanceof Error ? e.constructor.name : '';
  if (/Error$/.test(name) && name !== 'Error' && name !== 'TypeError' && name !== 'RangeError') {
    return 409; // LedgerError/BillingError/PaymentError/AgreementError/… — conflict with current state
  }
  return 500;
}

interface Route {
  method: string;
  regex: RegExp;
  keys: string[];
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
  /** Seed units so agreement.create can validate ownership + subscription can meter. */
  units?: Array<{ id: string; tenantId: string }>;
  /** Server clock; overridable for deterministic tests. */
  now?: () => string;
}

export class App {
  readonly ledger = new Ledger();
  readonly calendar = new Calendar();
  readonly exceptions = new ExceptionQueue();
  readonly runtime: AgentRuntime;
  readonly billing: Billing;
  readonly payments: Payments;
  readonly deposits: Deposits;

  private readonly auth: Authenticator;
  private readonly plan: SubscriptionPlan;
  private readonly now: () => string;
  private readonly units = new Map<string, { id: string; tenantId: string }>();
  private readonly agreements = new Map<string, { agreement: Agreement; tenantId: string }>();
  private readonly invoiceTenant = new Map<string, string>();
  private readonly depositTenant = new Map<string, string>();
  private readonly routes: Route[] = [];

  constructor(config: AppConfig = {}) {
    this.runtime = new AgentRuntime(new PolicyEnvelope(), this.exceptions);
    this.billing = new Billing(this.ledger);
    this.payments = new Payments(this.ledger, this.billing);
    this.deposits = new Deposits(this.ledger);
    this.auth = config.authenticator ?? new StaticTokenAuthenticator();
    this.plan = config.subscriptionPlan ?? { perUnitCents: 5000, currency: 'BRL' };
    this.now = config.now ?? (() => new Date().toISOString());
    for (const u of config.units ?? []) this.units.set(u.id, { ...u });
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
      const params: Record<string, string> = {};
      route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)));
      try {
        return route.handler(ctx, params, req.body ?? {});
      } catch (e) {
        const status = statusForError(e);
        return { status, body: { error: e instanceof Error ? e.message : String(e) } };
      }
    }
    return { status: 404, body: { error: 'not found' } };
  }

  private add(
    method: string,
    pattern: string,
    handler: Route['handler'],
  ): void {
    const { regex, keys } = compile(pattern);
    this.routes.push({ method, regex, keys, handler });
  }

  // Run a mutation through the policy envelope and map the outcome to HTTP.
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

  private agreementSummary(a: Agreement) {
    return { id: a.id, kind: a.kind, status: a.status, rateCents: a.rateCents, period: a.period };
  }

  private ownedAgreement(ctx: AuthContext, id: string): Agreement {
    const entry = this.agreements.get(id);
    if (!entry || entry.tenantId !== ctx.tenantId) throw new HttpError(404, 'agreement not found');
    return entry.agreement;
  }

  private registerRoutes(): void {
    this.add('GET', '/health', () => ({ status: 200, body: { ok: true } }));

    // --- agreements --------------------------------------------------------
    this.add('POST', '/agreements', (ctx, _p, body) => {
      const id = this.requireString(body, 'id');
      const unitId = this.requireString(body, 'unitId');
      const unit = this.units.get(unitId);
      if (this.units.size > 0 && (!unit || unit.tenantId !== ctx.tenantId)) {
        throw new HttpError(404, 'unit not found for tenant');
      }
      const guestId = this.requireString(body, 'guestId');
      const kind = this.requireString(body, 'kind') as AgreementKind;
      const start = this.requireString(body, 'start');
      const end = this.requireString(body, 'end');
      const rateCents = this.requireInt(body, 'rateCents');
      const at = typeof body['at'] === 'string' ? (body['at'] as string) : this.now();
      if (this.agreements.has(id)) throw new HttpError(409, `agreement ${id} already exists`);

      return this.gated(
        'agreement.create',
        ctx,
        { unitId },
        () => {
          const a = Agreement.create({
            id,
            tenantId: ctx.tenantId,
            guestId,
            unitId,
            kind,
            start,
            end,
            rateCents,
            currency: typeof body['currency'] === 'string' ? (body['currency'] as string) : undefined,
            at,
          });
          // Hold inventory now so double-booking fails here (invariant 4).
          this.calendar.hold({ id: `${id}-hold`, unitId, holderId: id, start, end });
          this.agreements.set(id, { agreement: a, tenantId: ctx.tenantId });
          return a;
        },
        (a) => ({ status: 201, body: this.agreementSummary(a) }),
      );
    });

    this.add('POST', '/agreements/:id/activate', (ctx, p, body) => {
      const a = this.ownedAgreement(ctx, p['id']!);
      const at = typeof body['at'] === 'string' ? (body['at'] as string) : this.now();
      return this.gated('agreement.activate', ctx, {}, () => a.activate(at), () => ({
        status: 200,
        body: this.agreementSummary(a),
      }));
    });

    this.add('POST', '/agreements/:id/convert', (ctx, p, body) => {
      const a = this.ownedAgreement(ctx, p['id']!);
      const to = this.requireString(body, 'to') as AgreementKind;
      const at = typeof body['at'] === 'string' ? (body['at'] as string) : this.now();
      const opts: { rateCents?: number; end?: string } = {};
      if (typeof body['rateCents'] === 'number') opts.rateCents = body['rateCents'] as number;
      if (typeof body['end'] === 'string') opts.end = body['end'] as string;
      return this.gated('agreement.convert', ctx, { to }, () => a.convert(to, at, opts), () => ({
        status: 200,
        body: this.agreementSummary(a),
      }));
    });

    this.add('GET', '/agreements/:id', (ctx, p) => {
      const a = this.ownedAgreement(ctx, p['id']!);
      return { status: 200, body: { ...this.agreementSummary(a), history: a.history } };
    });

    // --- invoices ----------------------------------------------------------
    this.add('POST', '/invoices', (ctx, _p, body) => {
      const id = this.requireString(body, 'id');
      const agreementId = this.requireString(body, 'agreementId');
      this.ownedAgreement(ctx, agreementId); // tenant check
      const dueAt = this.requireString(body, 'dueAt');
      const issuedAt = typeof body['issuedAt'] === 'string' ? (body['issuedAt'] as string) : this.now();
      const rawLines = Array.isArray(body['lines']) ? (body['lines'] as unknown[]) : [];
      const lines: InvoiceLine[] = rawLines.map((l) => {
        const o = l as Record<string, unknown>;
        return {
          description: String(o['description'] ?? ''),
          account: String(o['account'] ?? ''),
          amountCents: Number(o['amountCents']),
        };
      });
      return this.gated(
        'invoice.issue',
        ctx,
        { agreementId },
        () => {
          const inv = this.billing.issue({ id, agreementId, tenantId: ctx.tenantId, issuedAt, dueAt, lines });
          this.invoiceTenant.set(id, ctx.tenantId);
          return inv;
        },
        (inv) => ({ status: 201, body: inv }),
      );
    });

    this.add('GET', '/invoices/:id', (ctx, p) => {
      if (this.invoiceTenant.get(p['id']!) !== ctx.tenantId) throw new HttpError(404, 'invoice not found');
      return { status: 200, body: this.billing.get(p['id']!) };
    });

    // --- payments ----------------------------------------------------------
    this.add('POST', '/payments', (ctx, _p, body) => {
      const id = this.requireString(body, 'id');
      const invoiceId = this.requireString(body, 'invoiceId');
      if (this.invoiceTenant.get(invoiceId) !== ctx.tenantId) throw new HttpError(404, 'invoice not found');
      const amountCents = this.requireInt(body, 'amountCents');
      const method = this.requireString(body, 'method') as PaymentMethod;
      const receivedAt = typeof body['receivedAt'] === 'string' ? (body['receivedAt'] as string) : this.now();
      return this.gated(
        'payment.record',
        ctx,
        { amountCents, invoiceId },
        () => this.payments.record({ id, invoiceId, amountCents, method, receivedAt }),
        (pay) => ({ status: 201, body: pay }),
      );
    });

    // --- deposits ----------------------------------------------------------
    this.add('POST', '/deposits', (ctx, _p, body) => {
      const id = this.requireString(body, 'id');
      const agreementId = this.requireString(body, 'agreementId');
      this.ownedAgreement(ctx, agreementId);
      const amountCents = this.requireInt(body, 'amountCents');
      const heldAt = typeof body['heldAt'] === 'string' ? (body['heldAt'] as string) : this.now();
      return this.gated(
        'deposit.hold',
        ctx,
        { agreementId, amountCents },
        () => {
          const d = this.deposits.hold({ id, agreementId, amountCents, heldAt });
          this.depositTenant.set(id, ctx.tenantId);
          return d;
        },
        (d) => ({ status: 201, body: d }),
      );
    });

    this.add('POST', '/deposits/:id/refund', (ctx, p, body) => {
      const id = p['id']!;
      if (this.depositTenant.get(id) !== ctx.tenantId) throw new HttpError(404, 'deposit not found');
      const at = typeof body['at'] === 'string' ? (body['at'] as string) : this.now();
      const rawDeductions = Array.isArray(body['deductions']) ? (body['deductions'] as unknown[]) : [];
      const deductions: Deduction[] = rawDeductions.map((d) => {
        const o = d as Record<string, unknown>;
        return { reason: String(o['reason'] ?? ''), amountCents: Number(o['amountCents']) };
      });
      return this.gated(
        'deposit.refund',
        ctx,
        { depositId: id },
        () => this.deposits.refund(id, at, deductions),
        (d) => ({ status: 200, body: d }),
      );
    });

    // --- ledger (tenant-scoped) -------------------------------------------
    this.add('GET', '/ledger/trial-balance', (ctx) => {
      const tenantAgreementIds = new Set(
        [...this.agreements.values()].filter((e) => e.tenantId === ctx.tenantId).map((e) => e.agreement.id),
      );
      const balances: Record<string, number> = {};
      for (const line of this.ledger.allLines) {
        if (!line.agreementId || !tenantAgreementIds.has(line.agreementId)) continue;
        balances[line.account] = (balances[line.account] ?? 0) + line.debitCents - line.creditCents;
      }
      const net = Object.values(balances).reduce((s, v) => s + v, 0);
      return { status: 200, body: { balances, net, balanced: net === 0 } };
    });

    // --- exceptions --------------------------------------------------------
    this.add('GET', '/exceptions', (ctx) => {
      const pending = this.exceptions
        .pending()
        .filter((i) => (i.ctx as { tenantId?: string }).tenantId === ctx.tenantId);
      return { status: 200, body: { pending } };
    });

    this.add('POST', '/exceptions/:id/approve', (ctx, p, body) => {
      if (ctx.role === 'agent' || ctx.role === 'guest') {
        throw new HttpError(403, 'approving an escalation requires a staff or service role');
      }
      const item = this.exceptions.get(p['id']!); // throws -> 409 if unknown
      if ((item.ctx as { tenantId?: string }).tenantId !== ctx.tenantId) {
        throw new HttpError(404, 'exception not found');
      }
      const note = typeof body['note'] === 'string' ? (body['note'] as string) : undefined;
      const result = this.exceptions.approve(p['id']!, ctx.actor, this.now(), note);
      return { status: 200, body: { status: 'approved', result: result ?? null } };
    });

    // --- billing (per-unit SaaS: platform charge to the operator) ----------
    this.add('GET', '/billing/subscription', (ctx) => {
      const unitCount = [...this.units.values()].filter((u) => u.tenantId === ctx.tenantId).length;
      return { status: 200, body: meterSubscription(unitCount, this.plan) };
    });
  }
}
