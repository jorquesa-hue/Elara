// PolicyEnvelope: every agent tool-call is decided here BEFORE execution
// (invariant 2 — no bypass paths). The POLICY_RULES array below is the single
// source of truth (invariant 5); supabase/policy_rule.seed.sql is generated
// from it by scripts/gen-seed.mjs and must never be hand-edited.

export type PolicyEffect = 'allow' | 'deny' | 'escalate';

export interface PolicyContext {
  actor: string;
  tenantId?: string;
  jurisdiction?: string;
  amountCents?: number;
  [key: string]: unknown;
}

export interface PolicyRule {
  id: string;
  action: string;
  effect: PolicyEffect;
  description: string;
  /** Optional guard; the rule matches only when this returns true. */
  when?: (ctx: PolicyContext) => boolean;
  /** Human-readable rendering of `when`, carried into the SQL seed. */
  conditionNote?: string;
}

export interface PolicyDecision {
  effect: PolicyEffect;
  action: string;
  ruleId: string | null;
  reason: string;
}

export class PolicyViolationError extends Error {}

// First matching rule wins; order within an action matters.
export const POLICY_RULES: readonly PolicyRule[] = [
  { id: 'pol-agreement-create', action: 'agreement.create', effect: 'allow', description: 'Agents may draft agreements.' },
  { id: 'pol-agreement-activate', action: 'agreement.activate', effect: 'allow', description: 'Agents may activate drafted agreements.' },
  { id: 'pol-agreement-convert', action: 'agreement.convert', effect: 'allow', description: 'Forward conversion nightly→monthly→lease is a routine, reversible-by-amendment operation.' },
  { id: 'pol-agreement-adjust-rent', action: 'agreement.adjust_rent', effect: 'allow', description: 'Scheduled rent adjustments within the lease escalation terms are routine and fully audited.' },
  { id: 'pol-agreement-transfer', action: 'agreement.transfer', effect: 'allow', description: 'Unit transfers within a property preserve the agreement and its ledger; routine.' },
  {
    id: 'pol-lease-execute',
    action: 'lease.execute',
    effect: 'escalate',
    description: 'Executing a lease in BR/EU is regulated and irreversible: propose to human, never execute.',
  },
  { id: 'pol-invoice-issue', action: 'invoice.issue', effect: 'allow', description: 'Agents may issue invoices from rate plans.' },
  { id: 'pol-payment-record', action: 'payment.record', effect: 'allow', description: 'Agents may record settled payments (no provider credentials in kernel).' },
  {
    id: 'pol-payment-refund-large',
    action: 'payment.refund',
    effect: 'escalate',
    description: 'Refunds above R$500 require human approval.',
    when: (ctx) => (ctx.amountCents ?? 0) > 50_000,
    conditionNote: 'amount_cents > 50000',
  },
  { id: 'pol-payment-refund', action: 'payment.refund', effect: 'allow', description: 'Small refunds are routine.' },
  { id: 'pol-deposit-hold', action: 'deposit.hold', effect: 'allow', description: 'Agents may take security deposits per rate plan.' },
  { id: 'pol-deposit-refund', action: 'deposit.refund', effect: 'allow', description: 'Deposit refunds with itemized deductions are routine.' },
  { id: 'pol-amenity-charge', action: 'amenity.charge', effect: 'allow', description: 'Agents may post catalog amenity charges.' },
  { id: 'pol-nfe-ingest', action: 'nfe.ingest', effect: 'allow', description: 'Agents may ingest supplier NF-e documents into AP.' },
  { id: 'pol-bill-issue', action: 'bill.issue', effect: 'allow', description: 'Agents may record vendor bills and resident refunds into accounts payable.' },
  {
    id: 'pol-bill-pay-large',
    action: 'bill.pay',
    effect: 'escalate',
    description: 'Paying more than R$5,000 out requires human approval (money leaves the business).',
    when: (ctx) => (ctx.amountCents ?? 0) > 500_000,
    conditionNote: 'amount_cents > 500000',
  },
  { id: 'pol-bill-pay', action: 'bill.pay', effect: 'allow', description: 'Routine payables settlement is auto-approved; real bank-rail payout (a future integration) will tighten this.' },
  { id: 'pol-workorder-open', action: 'work_order.open', effect: 'allow', description: 'Agents may raise maintenance work orders.' },
  { id: 'pol-workorder-update', action: 'work_order.update', effect: 'allow', description: 'Assigning a vendor and starting work are routine.' },
  { id: 'pol-workorder-close', action: 'work_order.close', effect: 'allow', description: 'Completing or cancelling a work order is routine.' },
  { id: 'pol-collections-remind', action: 'collections.remind', effect: 'allow', description: 'Payment reminders are routine.' },
  { id: 'pol-collections-latefee', action: 'collections.late_fee', effect: 'allow', description: 'Contractual late fees are routine.' },
  { id: 'pol-collections-suspend', action: 'collections.suspend', effect: 'escalate', description: 'Service suspension is guest-impacting: human confirms.' },
  {
    id: 'pol-collections-evict',
    action: 'collections.evict',
    effect: 'escalate',
    description: 'Eviction is irreversible and regulated: propose to human, never execute.',
  },
  { id: 'pol-groupblock-create', action: 'group_block.create', effect: 'allow', description: 'Agents may place group blocks.' },
  { id: 'pol-groupblock-pickup', action: 'group_block.pickup', effect: 'allow', description: 'Agents may convert block holds into agreements.' },
] as const;

export class PolicyEnvelope {
  private readonly rules: readonly PolicyRule[];

  constructor(rules: readonly PolicyRule[] = POLICY_RULES, extraRules: readonly PolicyRule[] = []) {
    this.rules = [...rules, ...extraRules];
  }

  /** Decide BEFORE execution. Unknown actions are denied by default. */
  decide(action: string, ctx: PolicyContext): PolicyDecision {
    for (const rule of this.rules) {
      if (rule.action !== action) continue;
      if (rule.when && !rule.when(ctx)) continue;
      return { effect: rule.effect, action, ruleId: rule.id, reason: rule.description };
    }
    return {
      effect: 'deny',
      action,
      ruleId: null,
      reason: `no policy rule matches '${action}' — deny by default`,
    };
  }
}
