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
  | 'completed'
  | 'terminated';

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
      if ((e.type === 'converted' || e.type === 'amended') && e.payload['rateCents'] !== undefined) {
        rate = e.payload['rateCents'] as number;
      }
    }
    return rate;
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

  hold(h: { id: string; unitId: string; holderId: string; start: string; end: string }): CalendarHold {
    if (this.holds.has(h.id)) throw new AgreementError(`duplicate hold id: ${h.id}`);
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
}
