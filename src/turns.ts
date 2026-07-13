// Unit turns (make-ready) — the operations board that tracks a vacant unit from
// move-out through its make-ready checklist to rent-ready. Turn time (days from
// vacate to ready) is THE multifamily ops KPI, so a turn carries its vacatedAt
// and readyAt and a per-task checklist. A PURE, zero-dep state machine, tenant-
// scoped, in the same shape as tours/applications so persistence stays uniform.

export type TurnStatus = 'open' | 'in_progress' | 'ready' | 'cancelled';

export interface TurnTask {
  key: string; // clean, paint, repair, inspect, keys…
  label: string;
  done: boolean;
  doneAt?: string;
}

/** The default make-ready checklist a turn opens with. */
export const DEFAULT_TURN_TASKS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'clean', label: 'Deep clean' },
  { key: 'paint', label: 'Paint / touch-up' },
  { key: 'repair', label: 'Repairs' },
  { key: 'inspect', label: 'Final inspection' },
  { key: 'keys', label: 'Re-key / access' },
];

export interface Turn {
  id: string;
  tenantId: string;
  unitId: string;
  status: TurnStatus;
  vacatedAt: string; // when the unit went vacant (the turn clock starts)
  readyAt?: string; // when it became rent-ready (the clock stops)
  tasks: TurnTask[];
  agentId?: string;
  notes?: string;
  createdAt: string;
  cancelReason?: string;
}

export class TurnError extends Error {}

export class Turns {
  private turns = new Map<string, Turn>();

  hydrate(records: readonly Turn[]): void {
    for (const r of records) this.turns.set(r.id, { ...r, tasks: r.tasks.map((t) => ({ ...t })) });
  }

  open(input: { id: string; tenantId: string; unitId: string; vacatedAt: string; createdAt: string; agentId?: string; notes?: string; tasks?: ReadonlyArray<{ key: string; label: string }> }): Turn {
    if (this.turns.has(input.id)) throw new TurnError(`duplicate turn: ${input.id}`);
    if (!input.unitId) throw new TurnError(`turn ${input.id}: unitId is required`);
    if (!input.vacatedAt) throw new TurnError(`turn ${input.id}: vacatedAt is required`);
    const source = input.tasks && input.tasks.length ? input.tasks : DEFAULT_TURN_TASKS;
    const turn: Turn = {
      id: input.id,
      tenantId: input.tenantId,
      unitId: input.unitId,
      status: 'open',
      vacatedAt: input.vacatedAt,
      tasks: source.map((t) => ({ key: t.key, label: t.label, done: false })),
      createdAt: input.createdAt,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.notes ? { notes: input.notes } : {}),
    };
    this.turns.set(turn.id, turn);
    return this.get(turn.id);
  }

  get(id: string): Turn {
    const t = this.turns.get(id);
    if (!t) throw new TurnError(`unknown turn: ${id}`);
    return { ...t, tasks: t.tasks.map((x) => ({ ...x })) };
  }

  /** Mark a checklist task done (or undone). Advances an open turn to in_progress. */
  setTask(id: string, key: string, done: boolean, at: string): Turn {
    const t = this.mutable(id);
    if (t.status === 'ready' || t.status === 'cancelled') throw new TurnError(`turn ${id} is ${t.status}`);
    const task = t.tasks.find((x) => x.key === key);
    if (!task) throw new TurnError(`turn ${id} has no task '${key}'`);
    task.done = done;
    task.doneAt = done ? at : undefined;
    if (t.status === 'open' && t.tasks.some((x) => x.done)) t.status = 'in_progress';
    return this.get(id);
  }

  /** Mark the unit rent-ready. Requires every checklist task complete. */
  markReady(id: string, at: string): Turn {
    const t = this.mutable(id);
    if (t.status === 'ready' || t.status === 'cancelled') throw new TurnError(`turn ${id} is ${t.status}`);
    if (t.tasks.some((x) => !x.done)) throw new TurnError(`turn ${id} has incomplete make-ready tasks`);
    t.status = 'ready';
    t.readyAt = at;
    return this.get(id);
  }

  cancel(id: string, reason?: string): Turn {
    const t = this.mutable(id);
    if (t.status === 'ready' || t.status === 'cancelled') throw new TurnError(`turn ${id} is ${t.status}`);
    t.status = 'cancelled';
    if (reason) t.cancelReason = reason;
    return this.get(id);
  }

  list(tenantId: string): Turn[] {
    return [...this.turns.values()].filter((t) => t.tenantId === tenantId).map((t) => this.get(t.id));
  }

  private mutable(id: string): Turn {
    const t = this.turns.get(id);
    if (!t) throw new TurnError(`unknown turn: ${id}`);
    return t;
  }
}

/** Whole days from vacate to ready (or to `asOf` if still open) — the turn-time KPI. */
export function turnDays(turn: Turn, asOf: string): number {
  const end = turn.readyAt ?? asOf;
  const a = Date.parse(turn.vacatedAt.slice(0, 10));
  const b = Date.parse(end.slice(0, 10));
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86400000));
}
