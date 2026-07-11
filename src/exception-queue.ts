// Exception queue: where escalated actions wait for a human decision.
// Approval executes the deferred operation; rejection discards it. Items are
// never deleted — resolution is a state change, keeping the audit trail whole.

import type { PolicyContext } from './policy-envelope.ts';

export type ExceptionStatus = 'pending' | 'approved' | 'rejected';

export interface ExceptionItem {
  id: string;
  action: string;
  ctx: PolicyContext;
  reason: string;
  status: ExceptionStatus;
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  note?: string;
}

export class ExceptionQueueError extends Error {}

export class ExceptionQueue {
  private items = new Map<string, ExceptionItem>();
  private thunks = new Map<string, () => unknown>();
  private counter = 0;

  enqueue(input: {
    action: string;
    ctx: PolicyContext;
    reason: string;
    at: string;
    execute?: () => unknown;
  }): ExceptionItem {
    const id = `exc-${++this.counter}`;
    const item: ExceptionItem = {
      id,
      action: input.action,
      ctx: input.ctx,
      reason: input.reason,
      status: 'pending',
      createdAt: input.at,
    };
    this.items.set(id, item);
    if (input.execute) this.thunks.set(id, input.execute);
    return { ...item };
  }

  pending(): readonly ExceptionItem[] {
    return [...this.items.values()].filter((i) => i.status === 'pending').map((i) => ({ ...i }));
  }

  /** Every item, resolved or not — the persistence snapshot (items are never
   *  deleted; resolution is a state change, so the whole queue is the record). */
  all(): readonly ExceptionItem[] {
    return [...this.items.values()].map((i) => ({ ...i }));
  }

  /** Whether an item still carries its deferred operation. A rehydrated item
   *  never does (a closure cannot be persisted) — approving it records the
   *  human decision without auto-executing; the operator re-runs the action. */
  hasThunk(id: string): boolean {
    return this.thunks.has(id);
  }

  /** Load stored items for cold-start rehydration. Deferred thunks are gone —
   *  see hasThunk(). The id counter resumes past the highest loaded exc-N so
   *  new escalations never collide with rehydrated ones. */
  hydrate(items: readonly ExceptionItem[]): void {
    for (const i of items) {
      this.items.set(i.id, { ...i });
      const n = /^exc-(\d+)$/.exec(i.id);
      if (n) this.counter = Math.max(this.counter, Number(n[1]));
    }
  }

  get(id: string): ExceptionItem {
    const item = this.items.get(id);
    if (!item) throw new ExceptionQueueError(`unknown exception: ${id}`);
    return { ...item };
  }

  /** Human approval: marks approved and runs the deferred operation, if any. */
  approve(id: string, by: string, at: string, note?: string): unknown {
    const item = this.requirePending(id);
    item.status = 'approved';
    item.resolvedAt = at;
    item.resolvedBy = by;
    item.note = note;
    const thunk = this.thunks.get(id);
    this.thunks.delete(id);
    return thunk ? thunk() : undefined;
  }

  reject(id: string, by: string, at: string, note?: string): void {
    const item = this.requirePending(id);
    item.status = 'rejected';
    item.resolvedAt = at;
    item.resolvedBy = by;
    item.note = note;
    this.thunks.delete(id);
  }

  private requirePending(id: string): ExceptionItem {
    const item = this.items.get(id);
    if (!item) throw new ExceptionQueueError(`unknown exception: ${id}`);
    if (item.status !== 'pending') {
      throw new ExceptionQueueError(`exception ${id} already ${item.status}`);
    }
    return item;
  }
}
