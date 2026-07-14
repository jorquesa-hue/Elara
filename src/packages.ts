// Package / parcel room — residents receive deliveries at the front desk, which
// logs each parcel against the recipient, notifies them it has arrived, and
// records pickup. A high-volume multifamily front-desk task (a busy community
// takes hundreds of packages a week), so a clean log + a "who still has one
// waiting" view matters. A PURE, zero-dep tenant-scoped registry; the arrival
// notification rides the existing outbox (kind package_arrival) from the App.

export type ParcelStatus = 'awaiting' | 'notified' | 'picked_up';

export interface Parcel {
  id: string;
  tenantId: string;
  partyId: string; // the recipient resident
  agreementId?: string; // their lease (for the unit label), optional
  carrier: string; // UPS, FedEx, USPS, Amazon…
  trackingNumber?: string;
  description?: string; // "large box", "envelope"…
  location?: string; // where it's stored (shelf B3, mail room…)
  status: ParcelStatus;
  receivedAt: string; // when it arrived at the desk (the clock starts)
  notifiedAt?: string;
  pickedUpAt?: string;
  pickedUpBy?: string; // who collected it (resident / authorized person)
  notes?: string;
}

export class ParcelError extends Error {}

const day = (iso: string) => Date.parse(iso.slice(0, 10));

/** Whole days a parcel has sat at the desk (received → picked up, or → asOf). */
export function parcelDaysWaiting(p: Parcel, asOf: string): number {
  const end = p.pickedUpAt ?? asOf;
  const a = day(p.receivedAt), b = day(end);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

export class Parcels {
  private parcels = new Map<string, Parcel>();

  hydrate(records: readonly Parcel[]): void {
    for (const r of records) this.parcels.set(r.id, { ...r });
  }

  log(input: {
    id: string; tenantId: string; partyId: string; carrier: string; receivedAt: string;
    agreementId?: string; trackingNumber?: string; description?: string; location?: string; notes?: string;
  }): Parcel {
    if (this.parcels.has(input.id)) throw new ParcelError(`duplicate parcel: ${input.id}`);
    if (!input.partyId) throw new ParcelError(`parcel ${input.id}: partyId (recipient) is required`);
    if (!input.carrier) throw new ParcelError(`parcel ${input.id}: carrier is required`);
    if (!input.receivedAt) throw new ParcelError(`parcel ${input.id}: receivedAt is required`);
    const p: Parcel = {
      id: input.id,
      tenantId: input.tenantId,
      partyId: input.partyId,
      carrier: input.carrier,
      status: 'awaiting',
      receivedAt: input.receivedAt,
      ...(input.agreementId ? { agreementId: input.agreementId } : {}),
      ...(input.trackingNumber ? { trackingNumber: input.trackingNumber } : {}),
      ...(input.description ? { description: input.description } : {}),
      ...(input.location ? { location: input.location } : {}),
      ...(input.notes ? { notes: input.notes } : {}),
    };
    this.parcels.set(p.id, p);
    return this.get(p.id);
  }

  get(id: string): Parcel {
    const p = this.parcels.get(id);
    if (!p) throw new ParcelError(`unknown parcel: ${id}`);
    return { ...p };
  }

  markNotified(id: string, at: string): Parcel {
    const p = this.mutable(id);
    if (p.status === 'picked_up') throw new ParcelError(`parcel ${id} has already been picked up`);
    if (p.status === 'awaiting') p.status = 'notified';
    p.notifiedAt = at;
    return this.get(id);
  }

  markPickedUp(id: string, at: string, by?: string): Parcel {
    const p = this.mutable(id);
    if (p.status === 'picked_up') throw new ParcelError(`parcel ${id} has already been picked up`);
    p.status = 'picked_up';
    p.pickedUpAt = at;
    if (by) p.pickedUpBy = by;
    return this.get(id);
  }

  /** Parcels still at the desk (not yet picked up). */
  awaiting(tenantId: string): Parcel[] {
    return [...this.parcels.values()].filter((p) => p.tenantId === tenantId && p.status !== 'picked_up').map((p) => this.get(p.id));
  }

  forParty(partyId: string): Parcel[] {
    return [...this.parcels.values()].filter((p) => p.partyId === partyId).map((p) => this.get(p.id));
  }

  list(tenantId: string): Parcel[] {
    return [...this.parcels.values()].filter((p) => p.tenantId === tenantId).map((p) => this.get(p.id));
  }

  private mutable(id: string): Parcel {
    const p = this.parcels.get(id);
    if (!p) throw new ParcelError(`unknown parcel: ${id}`);
    return p;
  }
}
