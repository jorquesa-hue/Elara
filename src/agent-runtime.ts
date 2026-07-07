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
      this.record(at, ctx.actor, action, decision.effect, decision.ruleId, 'executed', decision.reason);
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
      this.record(at, ctx.actor, action, decision.effect, decision.ruleId, 'escalated', decision.reason, item.id);
      return { outcome: 'escalated', exceptionId: item.id, reason: decision.reason };
    }

    this.record(at, ctx.actor, action, decision.effect, decision.ruleId, 'denied', decision.reason);
    return { outcome: 'denied', reason: decision.reason };
  }

  private record(
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
}
