// Preventive maintenance schedules — recurring upkeep (HVAC service, filter
// changes, fire-alarm tests) that a sweep turns into work orders on a cadence,
// so routine maintenance happens on time instead of only when something breaks.
// A PURE, zero-dep tenant-scoped registry; the sweep itself lives in the App
// (it raises work orders through the gated work_order.open path). The schedule
// carries its cadence + nextDueAt; markRun advances nextDueAt by the cadence.

export interface PmSchedule {
  id: string;
  tenantId: string;
  title: string;
  spaceId?: string; // where the task runs (a leasable/common space); optional
  cadenceDays: number; // how often (e.g. 30, 90, 365)
  priority: string; // low | normal | high | urgent (the work-order priority set)
  nextDueAt: string; // ISO date the next occurrence is due
  lastRunAt?: string; // when the sweep last raised a WO for it
  active: boolean;
  createdAt: string;
}

export class PmError extends Error {}

/** Add `days` to an ISO date (date-only granularity), returning YYYY-MM-DD. */
export function addDays(iso: string, days: number): string {
  const base = Date.parse(iso.slice(0, 10));
  if (Number.isNaN(base)) return iso;
  return new Date(base + days * 86400000).toISOString().slice(0, 10);
}

export class PreventiveMaintenance {
  private schedules = new Map<string, PmSchedule>();

  hydrate(records: readonly PmSchedule[]): void {
    for (const r of records) this.schedules.set(r.id, { ...r });
  }

  create(input: { id: string; tenantId: string; title: string; cadenceDays: number; nextDueAt: string; createdAt: string; spaceId?: string; priority?: string }): PmSchedule {
    if (this.schedules.has(input.id)) throw new PmError(`duplicate PM schedule: ${input.id}`);
    if (!input.title) throw new PmError(`PM schedule ${input.id}: title is required`);
    if (!Number.isInteger(input.cadenceDays) || input.cadenceDays <= 0) throw new PmError(`PM schedule ${input.id}: cadenceDays must be a positive integer`);
    if (!input.nextDueAt) throw new PmError(`PM schedule ${input.id}: nextDueAt is required`);
    const s: PmSchedule = {
      id: input.id,
      tenantId: input.tenantId,
      title: input.title,
      cadenceDays: input.cadenceDays,
      priority: input.priority ?? 'normal',
      nextDueAt: input.nextDueAt.slice(0, 10),
      active: true,
      createdAt: input.createdAt,
      ...(input.spaceId ? { spaceId: input.spaceId } : {}),
    };
    this.schedules.set(s.id, s);
    return this.get(s.id);
  }

  get(id: string): PmSchedule {
    const s = this.schedules.get(id);
    if (!s) throw new PmError(`unknown PM schedule: ${id}`);
    return { ...s };
  }

  setActive(id: string, active: boolean): PmSchedule {
    const s = this.mutable(id);
    s.active = active;
    return this.get(id);
  }

  /** Record that a WO was raised for this schedule: advance nextDueAt by the
   *  cadence and stamp lastRunAt. Kept idempotent by the App via the WO id. */
  markRun(id: string, at: string): PmSchedule {
    const s = this.mutable(id);
    s.lastRunAt = at;
    s.nextDueAt = addDays(s.nextDueAt, s.cadenceDays);
    return this.get(id);
  }

  /** Active schedules whose nextDueAt is on/before `asOf` — the sweep's work list. */
  due(tenantId: string, asOf: string): PmSchedule[] {
    const day = asOf.slice(0, 10);
    return [...this.schedules.values()]
      .filter((s) => s.tenantId === tenantId && s.active && s.nextDueAt <= day)
      .sort((a, b) => a.nextDueAt.localeCompare(b.nextDueAt) || a.id.localeCompare(b.id))
      .map((s) => this.get(s.id));
  }

  list(tenantId: string): PmSchedule[] {
    return [...this.schedules.values()].filter((s) => s.tenantId === tenantId).map((s) => this.get(s.id));
  }

  private mutable(id: string): PmSchedule {
    const s = this.schedules.get(id);
    if (!s) throw new PmError(`unknown PM schedule: ${id}`);
    return s;
  }
}
