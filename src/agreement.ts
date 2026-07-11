// Agreement aggregate: event-sourced state machine covering the unified stay
// lifecycle nightly → monthly → lease. Conversion preserves the agreement id
// (behavioral guardrail: ledger continuity keys off that id).
// Calendar mirrors the DB EXCLUDE constraint on calendar_hold: overlapping
// active holds on one unit must be impossible (invariant 4 — the DB is the
// enforcement of record, this is the in-process mirror).

export type AgreementKind = 'nightly' | 'monthly' | 'lease';
export type AgreementStatus = 'draft' | 'active' | 'completed' | 'terminated';

export type AgreementEventType =
  | 'created'
  | 'activated'
  | 'converted'
  | 'amended'
  | 'rent_adjusted'
  | 'transferred'
  | 'moved_in'
  | 'moved_out'
  | 'lease_executed'
  | 'completed'
  | 'terminated';

/** A lease escalation rule: raise rent by a percent or a fixed minor-unit amount. */
export interface EscalationRule {
  mode: 'percent' | 'fixed';
  value: number; // percent points (e.g. 5 = +5%) or minor units when fixed
  capCents?: number; // optional ceiling on the resulting rate
}

/** Pure helper: the new rate after applying an escalation rule to the current one. */
export function escalatedRate(currentCents: number, rule: EscalationRule): number {
  let next =
    rule.mode === 'percent'
      ? Math.round(currentCents * (1 + rule.value / 100))
      : currentCents + rule.value;
  if (rule.capCents !== undefined) next = Math.min(next, rule.capCents);
  if (!Number.isInteger(next) || next <= 0) {
    throw new AgreementError(`escalated rate must be a positive integer, got ${next}`);
  }
  return next;
}

export interface AgreementEvent {
  seq: number;
  agreementId: string;
  type: AgreementEventType;
  at: string;
  payload: Record<string, unknown>;
}

export class AgreementError extends Error {}

const CONVERSION_ORDER: readonly AgreementKind[] = ['nightly', 'monthly', 'lease'];

export interface CreateAgreementInput {
  id: string;
  tenantId: string;
  guestId: string;
  unitId: string;
  kind: AgreementKind;
  start: string; // inclusive, ISO date
  end: string; // exclusive, ISO date
  rateCents: number;
  currency?: string;
  at: string;
}

export class Agreement {
  private events: AgreementEvent[] = [];

  private constructor(
    public readonly id: string,
    public readonly tenantId: string,
    public readonly guestId: string,
    public readonly unitId: string,
  ) {}

  static create(input: CreateAgreementInput): Agreement {
    const a = new Agreement(input.id, input.tenantId, input.guestId, input.unitId);
    a.append('created', input.at, {
      kind: input.kind,
      start: input.start,
      end: input.end,
      rateCents: input.rateCents,
      currency: input.currency ?? 'BRL',
    });
    return a;
  }

  /**
   * Reconstruct an aggregate from its persisted event stream (event sourcing).
   * Trusts the stored events — no transition validation is re-run — so the
   * fold (kind/status/rate/period) reproduces exactly what was persisted. The
   * first event must be 'created'.
   */
  static rehydrate(
    meta: { id: string; tenantId: string; guestId: string; unitId: string },
    events: readonly AgreementEvent[],
  ): Agreement {
    const ordered = [...events].sort((x, y) => x.seq - y.seq);
    if (ordered.length === 0 || ordered[0]!.type !== 'created') {
      throw new AgreementError(`cannot rehydrate ${meta.id}: event stream must start with 'created'`);
    }
    const a = new Agreement(meta.id, meta.tenantId, meta.guestId, meta.unitId);
    a.events = ordered.map((e) => Object.freeze({ ...e, payload: Object.freeze({ ...e.payload }) }));
    return a;
  }

  private append(type: AgreementEventType, at: string, payload: Record<string, unknown>): void {
    this.events.push(
      Object.freeze({
        seq: this.events.length + 1,
        agreementId: this.id,
        type,
        at,
        payload: Object.freeze({ ...payload }),
      }),
    );
  }

  /** Full event history — append-only, exposed as a copy. */
  get history(): readonly AgreementEvent[] {
    return [...this.events];
  }

  // --- fold ---------------------------------------------------------------

  get kind(): AgreementKind {
    let kind = this.events[0]!.payload['kind'] as AgreementKind;
    for (const e of this.events) {
      if (e.type === 'converted') kind = e.payload['to'] as AgreementKind;
    }
    return kind;
  }

  get status(): AgreementStatus {
    let status: AgreementStatus = 'draft';
    for (const e of this.events) {
      if (e.type === 'activated') status = 'active';
      if (e.type === 'completed') status = 'completed';
      if (e.type === 'terminated') status = 'terminated';
    }
    return status;
  }

  get rateCents(): number {
    let rate = this.events[0]!.payload['rateCents'] as number;
    for (const e of this.events) {
      if (
        (e.type === 'converted' || e.type === 'amended' || e.type === 'rent_adjusted' || e.type === 'transferred') &&
        e.payload['rateCents'] !== undefined
      ) {
        rate = e.payload['rateCents'] as number;
      }
    }
    return rate;
  }

  /**
   * The unit the agreement currently occupies. Starts at the created unit and
   * moves with each 'transferred' event — the agreement id and its ledger
   * history are preserved across a transfer (behavioral guardrail).
   */
  get currentUnitId(): string {
    let unit = this.unitId;
    for (const e of this.events) {
      if (e.type === 'transferred' && e.payload['toUnitId'] !== undefined) {
        unit = e.payload['toUnitId'] as string;
      }
    }
    return unit;
  }

  get period(): { start: string; end: string } {
    let start = this.events[0]!.payload['start'] as string;
    let end = this.events[0]!.payload['end'] as string;
    for (const e of this.events) {
      if (e.type === 'converted' || e.type === 'amended') {
        if (e.payload['start'] !== undefined) start = e.payload['start'] as string;
        if (e.payload['end'] !== undefined) end = e.payload['end'] as string;
      }
    }
    return { start, end };
  }

  // --- transitions ----------------------------------------------------------

  activate(at: string): void {
    if (this.status !== 'draft') {
      throw new AgreementError(`cannot activate agreement in status ${this.status}`);
    }
    this.append('activated', at, {});
  }

  /**
   * Convert forward along nightly → monthly → lease. The agreement id is
   * preserved; only a 'converted' event is appended.
   */
  convert(to: AgreementKind, at: string, opts: { rateCents?: number; end?: string } = {}): void {
    if (this.status !== 'active') {
      throw new AgreementError(`cannot convert agreement in status ${this.status}`);
    }
    const from = this.kind;
    const fromIdx = CONVERSION_ORDER.indexOf(from);
    const toIdx = CONVERSION_ORDER.indexOf(to);
    if (toIdx <= fromIdx) {
      throw new AgreementError(`conversion must move forward: ${from} → ${to} is not allowed`);
    }
    this.append('converted', at, {
      from,
      to,
      ...(opts.rateCents !== undefined ? { rateCents: opts.rateCents } : {}),
      ...(opts.end !== undefined ? { end: opts.end } : {}),
    });
  }

  amend(at: string, changes: { rateCents?: number; start?: string; end?: string }): void {
    if (this.status !== 'active') {
      throw new AgreementError(`cannot amend agreement in status ${this.status}`);
    }
    this.append('amended', at, { ...changes });
  }

  /**
   * Apply a rent adjustment (lease escalation, #8). The new rate is recorded as
   * a 'rent_adjusted' event carrying the prior rate, so the increase is fully
   * auditable. `basis` documents how the figure was reached (percent/fixed/manual).
   */
  adjustRent(
    at: string,
    input: { rateCents: number; basis?: 'percent' | 'fixed' | 'manual'; reason?: string },
  ): void {
    if (this.status !== 'active') {
      throw new AgreementError(`cannot adjust rent on agreement in status ${this.status}`);
    }
    if (!Number.isInteger(input.rateCents) || input.rateCents <= 0) {
      throw new AgreementError(`rateCents must be a positive integer, got ${input.rateCents}`);
    }
    this.append('rent_adjusted', at, {
      from: this.rateCents,
      rateCents: input.rateCents,
      ...(input.basis ? { basis: input.basis } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
    });
  }

  /**
   * Move the resident to another unit/space (#23). The agreement id and ledger
   * continuity are preserved; a 'transferred' event records from/to. An optional
   * new rate rides along when the target space is priced differently.
   */
  transfer(toUnitId: string, at: string, opts: { rateCents?: number; reason?: string } = {}): void {
    if (this.status !== 'active') {
      throw new AgreementError(`cannot transfer agreement in status ${this.status}`);
    }
    const fromUnitId = this.currentUnitId;
    if (!toUnitId || toUnitId === fromUnitId) {
      throw new AgreementError(`transfer target must differ from current unit ${fromUnitId}`);
    }
    this.append('transferred', at, {
      fromUnitId,
      toUnitId,
      ...(opts.rateCents !== undefined ? { rateCents: opts.rateCents } : {}),
      ...(opts.reason ? { reason: opts.reason } : {}),
    });
  }

  /** Record move-in (#19), optionally keyed to a move-in inspection (vistoria). */
  moveIn(at: string, opts: { inspectionId?: string; note?: string } = {}): void {
    if (this.status !== 'active') {
      throw new AgreementError(`cannot move in on agreement in status ${this.status}`);
    }
    this.append('moved_in', at, { ...(opts.inspectionId ? { inspectionId: opts.inspectionId } : {}), ...(opts.note ? { note: opts.note } : {}) });
  }

  /** Record move-out (#18), optionally keyed to a move-out inspection. */
  moveOut(at: string, opts: { inspectionId?: string; note?: string } = {}): void {
    if (this.status !== 'active') {
      throw new AgreementError(`cannot move out on agreement in status ${this.status}`);
    }
    this.append('moved_out', at, { ...(opts.inspectionId ? { inspectionId: opts.inspectionId } : {}), ...(opts.note ? { note: opts.note } : {}) });
  }

  /**
   * Legally EXECUTE (bind) the lease — the regulated, irreversible step, distinct
   * from converting the agreement's kind to 'lease'. It is only reachable through
   * the policy envelope's `lease.execute` rule, which ESCALATES in every
   * jurisdiction, so this only runs after a human approves the escalation — it is
   * never auto-executed (behavioral guardrail). Requires a lease that is active
   * and not already executed.
   */
  executeLease(at: string, opts: { documentRef?: string; note?: string } = {}): void {
    if (this.kind !== 'lease') {
      throw new AgreementError(`cannot execute a lease on a ${this.kind} agreement; convert to a lease first`);
    }
    if (this.status !== 'active') {
      throw new AgreementError(`cannot execute lease on agreement in status ${this.status}`);
    }
    if (this.leaseExecuted) {
      throw new AgreementError('lease is already executed');
    }
    this.append('lease_executed', at, {
      ...(opts.documentRef ? { documentRef: opts.documentRef } : {}),
      ...(opts.note ? { note: opts.note } : {}),
    });
  }

  /** Whether the lease has been legally executed (a `lease_executed` event exists). */
  get leaseExecuted(): boolean {
    return this.events.some((e) => e.type === 'lease_executed');
  }

  complete(at: string): void {
    if (this.status !== 'active') {
      throw new AgreementError(`cannot complete agreement in status ${this.status}`);
    }
    this.append('completed', at, {});
  }

  terminate(at: string, reason: string): void {
    if (this.status !== 'active') {
      throw new AgreementError(`cannot terminate agreement in status ${this.status}`);
    }
    this.append('terminated', at, { reason });
  }
}

// --- Calendar ---------------------------------------------------------------

export interface CalendarHold {
  id: string;
  unitId: string;
  /** Agreement or group-block that owns the hold. */
  holderId: string;
  start: string; // inclusive
  end: string; // exclusive
  status: 'active' | 'released';
}

export class DoubleInventoryError extends Error {}

function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart < bEnd && bStart < aEnd;
}

export class Calendar {
  private holds = new Map<string, CalendarHold>();

  /** Load stored calendar holds verbatim for cold-start rehydration. */
  hydrate(records: readonly CalendarHold[]): void {
    for (const r of records) this.holds.set(r.id, { ...r });
  }

  hold(h: { id: string; unitId: string; holderId: string; start: string; end: string }): CalendarHold {
    if (this.holds.has(h.id)) throw new AgreementError(`duplicate hold id: ${h.id}`);
    // The overlap check below compares date strings lexicographically, which is
    // only sound for ISO-8601. A malformed date ('07/15/2026', 'banana',
    // '2026-02-30') would silently defeat the no-double-booking guarantee here
    // (the DB EXCLUDE would still reject it at persist, but invariant 4 must not
    // depend on reaching the DB), so reject anything that isn't a real ISO date.
    for (const [label, v] of [['start', h.start], ['end', h.end]] as const) {
      const shaped = /^\d{4}-\d{2}-\d{2}(T[0-9:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(v) && !Number.isNaN(Date.parse(v));
      // A date-only string must also round-trip: V8 quietly parses '2026-02-30'
      // as March 2nd, but the DB daterange cast would reject it — same guarantee,
      // both layers.
      const canonical = v.length !== 10 || new Date(v).toISOString().slice(0, 10) === v;
      if (!shaped || !canonical) {
        throw new AgreementError(`hold ${h.id}: ${label} must be an ISO-8601 date, got '${v}'`);
      }
    }
    if (h.start >= h.end) throw new AgreementError(`hold ${h.id}: start must be before end`);
    for (const existing of this.holds.values()) {
      if (
        existing.status === 'active' &&
        existing.unitId === h.unitId &&
        overlaps(existing.start, existing.end, h.start, h.end)
      ) {
        throw new DoubleInventoryError(
          `unit ${h.unitId} already held ${existing.start}..${existing.end} by ${existing.holderId}`,
        );
      }
    }
    const hold: CalendarHold = { ...h, status: 'active' };
    this.holds.set(h.id, hold);
    return { ...hold };
  }

  release(id: string): void {
    const h = this.holds.get(id);
    if (!h) throw new AgreementError(`unknown hold: ${id}`);
    h.status = 'released';
  }

  holdsFor(unitId: string): readonly CalendarHold[] {
    return [...this.holds.values()].filter((h) => h.unitId === unitId).map((h) => ({ ...h }));
  }

  activeHolds(): readonly CalendarHold[] {
    return [...this.holds.values()].filter((h) => h.status === 'active').map((h) => ({ ...h }));
  }

  /** All holds (active + released), for persistence projection. */
  allHolds(): readonly CalendarHold[] {
    return [...this.holds.values()].map((h) => ({ ...h }));
  }
}
