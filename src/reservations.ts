// Common-area reservations (#6). A resident (or the operator) reserves a bookable
// space — a common area or amenity — for a time window. The reservation takes a
// calendar hold on that space so two reservations can't overlap (the same
// no-double-booking guarantee the DB EXCLUDE enforces, invariant 4), and may
// carry a price. Cancelling releases the hold. Money, when charged, flows through
// the existing invoice/charge path — this module owns only the booking lifecycle.

import { Calendar } from './agreement.ts';

export type ReservationStatus = 'reserved' | 'cancelled';

export interface ReservationRecord {
  id: string;
  tenantId: string;
  spaceId: string;
  holderPartyId: string; // who reserved it (a party)
  start: string; // inclusive ISO datetime/date
  end: string; // exclusive
  priceCents?: number;
  currency?: string;
  status: ReservationStatus;
  reservedAt: string;
  cancelledAt?: string;
  note?: string;
}

export class ReservationError extends Error {}

export class Reservations {
  private byId = new Map<string, ReservationRecord>();

  constructor(private readonly calendar: Calendar) {}

  /**
   * Reserve a bookable space. Places an active calendar hold keyed to the
   * reservation id, so an overlapping reservation on the same space is rejected
   * (DoubleInventoryError) exactly like a stay hold.
   */
  reserve(input: {
    id: string;
    tenantId: string;
    spaceId: string;
    holderPartyId: string;
    start: string;
    end: string;
    reservedAt: string;
    priceCents?: number;
    currency?: string;
    note?: string;
  }): ReservationRecord {
    if (this.byId.has(input.id)) throw new ReservationError(`duplicate reservation: ${input.id}`);
    if (input.start >= input.end) throw new ReservationError(`reservation ${input.id}: start must be before end`);
    if (input.priceCents !== undefined && (!Number.isInteger(input.priceCents) || input.priceCents < 0)) {
      throw new ReservationError(`reservation ${input.id}: priceCents must be a non-negative integer`);
    }
    // The Calendar throws DoubleInventoryError on an overlapping active hold.
    this.calendar.hold({
      id: `resv-${input.id}`,
      unitId: input.spaceId,
      holderId: input.id,
      start: input.start,
      end: input.end,
    });
    const rec: ReservationRecord = {
      id: input.id,
      tenantId: input.tenantId,
      spaceId: input.spaceId,
      holderPartyId: input.holderPartyId,
      start: input.start,
      end: input.end,
      priceCents: input.priceCents,
      currency: input.currency,
      status: 'reserved',
      reservedAt: input.reservedAt,
      note: input.note,
    };
    this.byId.set(rec.id, rec);
    return { ...rec };
  }

  get(id: string): ReservationRecord {
    const r = this.byId.get(id);
    if (!r) throw new ReservationError(`unknown reservation: ${id}`);
    return { ...r };
  }

  /** Cancel a reservation and release its hold so the slot frees up. */
  cancel(id: string, at: string): ReservationRecord {
    const r = this.byId.get(id);
    if (!r) throw new ReservationError(`unknown reservation: ${id}`);
    if (r.status === 'cancelled') throw new ReservationError(`reservation ${id} is already cancelled`);
    this.calendar.release(`resv-${id}`);
    r.status = 'cancelled';
    r.cancelledAt = at;
    return { ...r };
  }

  list(tenantId: string, filter: { spaceId?: string; status?: ReservationStatus } = {}): ReservationRecord[] {
    return [...this.byId.values()]
      .filter(
        (r) =>
          r.tenantId === tenantId &&
          (filter.spaceId === undefined || r.spaceId === filter.spaceId) &&
          (filter.status === undefined || r.status === filter.status),
      )
      .map((r) => ({ ...r }));
  }

  all(): readonly ReservationRecord[] {
    return [...this.byId.values()].map((r) => ({ ...r }));
  }
}
