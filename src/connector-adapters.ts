// Connector adapter routing — the pure decision layer the connector-worker edge
// function drains the outbox through. It is intentionally split from the actual
// vendor I/O (which lives in the edge, where the resolved credential exists) so
// the ROUTING POLICY — what may be dispatched, what is refused — is deterministic,
// zero-dependency, and unit-testable in the kernel. The edge worker mirrors this
// module (like projection.ts mirrors project.ts) and performs the real HTTP call
// only for kinds this policy marks `dispatch`.
//
// SAFETY (behavioral guardrail): bank / payment_gateway commands move real money
// over an external rail and would touch payment credentials. This module REFUSES
// them — a payout adapter must be written and enabled with explicit human approval,
// never auto-dispatched by the worker. (The policy envelope already ESCALATES a
// large connector payout before it is ever enqueued; this is defence-in-depth at
// the drain edge.)

export type IntegrationKind =
  | 'lock' | 'access_control' | 'elevator' | 'bank' | 'payment_gateway' | 'website' | 'crm' | 'fiscal';

/** Kinds the worker may actually dispatch to a vendor (hardware + software). A
 *  `fiscal` command emits a tax document (it does NOT move money — the payment
 *  already settled), so it is dispatchable, not a money rail. */
export const DISPATCHABLE_KINDS: readonly IntegrationKind[] = [
  'lock', 'access_control', 'elevator', 'website', 'crm', 'fiscal',
];

/** Kinds that move money and are refused at the drain edge (human-approved only). */
export const MONEY_KINDS: readonly IntegrationKind[] = ['bank', 'payment_gateway'];

export interface ConnectorCommandInput {
  action: string;
  kind: IntegrationKind;
  /** Whether the integration's secretRef resolved to a credential in the store. */
  secretResolved: boolean;
  payload?: Record<string, unknown>;
}

export type PlanDecision = 'dispatch' | 'refuse' | 'reject';

export interface ConnectorPlan {
  decision: PlanDecision;
  /** Machine-readable reason, recorded on the command result. */
  reason: string;
}

/**
 * Decide what the worker should do with a pending command — WITHOUT performing
 * any I/O. Deterministic and side-effect-free.
 *
 * - `reject`  — the command cannot proceed (unknown kind, missing credential, no
 *               action). Terminal failure; the operator must fix the integration.
 * - `refuse`  — a money rail (bank/payment_gateway). Never auto-dispatched; needs a
 *               human-approved payout adapter. Terminal failure with a clear reason.
 * - `dispatch`— a hardware/software kind with a resolved credential; the edge then
 *               performs the real vendor call.
 */
export function planConnectorCommand(input: ConnectorCommandInput): ConnectorPlan {
  if (!input.action) return { decision: 'reject', reason: 'missing_action' };
  if (MONEY_KINDS.includes(input.kind)) {
    return { decision: 'refuse', reason: 'money_rail_requires_human_approved_adapter' };
  }
  if (!DISPATCHABLE_KINDS.includes(input.kind)) {
    return { decision: 'reject', reason: `unsupported_kind:${input.kind}` };
  }
  if (!input.secretResolved) {
    return { decision: 'reject', reason: 'missing_secret' };
  }
  return { decision: 'dispatch', reason: 'ok' };
}

/** The command result the worker records after a `dispatch` plan. Kept here so the
 *  shape is shared; the edge fills `providerResponse` from the real vendor call. */
export interface DispatchOutcome {
  ok: boolean;
  reason: string;
  providerResponse?: Record<string, unknown>;
}
