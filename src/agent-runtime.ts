// AgentRuntime: the only path by which agents execute tool-calls. Every call
// passes PolicyEnvelope.decide() BEFORE execution (invariant 2). Every call —
// executed, denied, or escalated — lands in the append-only action log
// (invariant 1). Denied calls never run; escalated calls are parked on the
// exception queue and only run on explicit human approval.

import { PolicyEnvelope, type PolicyContext, type PolicyEffect } from './policy-envelope.ts';
import { ExceptionQueue } from './exception-queue.ts';

export type ActionOutcome = 'executed' | 'denied' | 'escalated';

export interface ActionLogRecord {
  seq: number;
  // The tenant whose action this was — the audit stream is a shared append-only
  // log, so every read/snapshot MUST filter by this to stay tenant-isolated.
  tenantId: string;
  at: string;
  actor: string;
  action: string;
  effect: PolicyEffect;
  ruleId: string | null;
  outcome: ActionOutcome;
  reason: string;
  exceptionId?: string;
}

export interface ToolCallResult<T> {
  outcome: ActionOutcome;
  result?: T;
  exceptionId?: string;
  reason: string;
}

export class AgentRuntime {
  private log: ActionLogRecord[] = [];

  constructor(
    private readonly envelope: PolicyEnvelope,
    private readonly exceptions: ExceptionQueue,
  ) {}

  execute<T>(action: string, ctx: PolicyContext, at: string, fn: () => T): ToolCallResult<T> {
    const decision = this.envelope.decide(action, ctx); // ALWAYS before fn

    if (decision.effect === 'allow') {
      const result = fn();
      this.record(ctx.tenantId ?? '', at, ctx.actor, action, decision.effect, decision.ruleId, 'executed', decision.reason);
      return { outcome: 'executed', result, reason: decision.reason };
    }

    if (decision.effect === 'escalate') {
      const item = this.exceptions.enqueue({
        action,
        ctx,
        reason: decision.reason,
        at,
        execute: fn,
      });
      this.record(ctx.tenantId ?? '', at, ctx.actor, action, decision.effect, decision.ruleId, 'escalated', decision.reason, item.id);
      return { outcome: 'escalated', exceptionId: item.id, reason: decision.reason };
    }

    this.record(ctx.tenantId ?? '', at, ctx.actor, action, decision.effect, decision.ruleId, 'denied', decision.reason);
    return { outcome: 'denied', reason: decision.reason };
  }

  private record(
    tenantId: string,
    at: string,
    actor: string,
    action: string,
    effect: PolicyEffect,
    ruleId: string | null,
    outcome: ActionOutcome,
    reason: string,
    exceptionId?: string,
  ): void {
    this.log.push(
      Object.freeze({
        seq: this.log.length + 1,
        tenantId,
        at,
        actor,
        action,
        effect,
        ruleId,
        outcome,
        reason,
        ...(exceptionId ? { exceptionId } : {}),
      }),
    );
  }

  actionLog(): readonly ActionLogRecord[] {
    return [...this.log];
  }

  /** The audit stream for a single tenant — the shared log filtered so a
   *  snapshot never carries another tenant's entries. */
  actionLogFor(tenantId: string): readonly ActionLogRecord[] {
    return this.log.filter((r) => r.tenantId === tenantId);
  }

  /** Restore the persisted action-log audit stream on cold-start rehydration. */
  hydrateLog(records: readonly ActionLogRecord[]): void {
    for (const r of records) this.log.push({ ...r });
  }
}
