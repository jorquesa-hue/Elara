// Prospect waitlist — when a floorplan is fully leased, prospects join a waitlist
// for it; as a unit turns available the office offers it to the top of the queue
// and converts that prospect into a CRM lead (the funnel resumes). The queue is
// FIFO by join time, so fairness is deterministic. A PURE, zero-dep tenant-scoped
// registry; converting to a lead lives in the App (it reuses crm.createLead).

export type WaitlistStatus = 'waiting' | 'offered' | 'converted' | 'withdrawn';

export interface WaitlistEntry {
  id: string;
  tenantId: string;
  typeId?: string; // the floorplan (unit type) wanted; optional
  propertyId?: string; // the community wanted; optional
  prospectName: string;
  prospectEmail?: string;
  prospectPhone?: string;
  desiredMoveIn?: string; // ISO date
  status: WaitlistStatus;
  joinedAt: string; // the queue clock — FIFO ordering key
  offeredAt?: string;
  convertedAt?: string;
  leadId?: string; // the CRM lead created on conversion
  notes?: string;
}

export class WaitlistError extends Error {}

export class Waitlist {
  private entries = new Map<string, WaitlistEntry>();

  hydrate(records: readonly WaitlistEntry[]): void {
    for (const r of records) this.entries.set(r.id, { ...r });
  }

  join(input: {
    id: string; tenantId: string; prospectName: string; joinedAt: string;
    typeId?: string; propertyId?: string; prospectEmail?: string; prospectPhone?: string; desiredMoveIn?: string; notes?: string;
  }): WaitlistEntry {
    if (this.entries.has(input.id)) throw new WaitlistError(`duplicate waitlist entry: ${input.id}`);
    if (!input.prospectName) throw new WaitlistError(`waitlist entry ${input.id}: prospectName is required`);
    const e: WaitlistEntry = {
      id: input.id,
      tenantId: input.tenantId,
      prospectName: input.prospectName,
      status: 'waiting',
      joinedAt: input.joinedAt,
      ...(input.typeId ? { typeId: input.typeId } : {}),
      ...(input.propertyId ? { propertyId: input.propertyId } : {}),
      ...(input.prospectEmail ? { prospectEmail: input.prospectEmail } : {}),
      ...(input.prospectPhone ? { prospectPhone: input.prospectPhone } : {}),
      ...(input.desiredMoveIn ? { desiredMoveIn: input.desiredMoveIn } : {}),
      ...(input.notes ? { notes: input.notes } : {}),
    };
    this.entries.set(e.id, e);
    return this.get(e.id);
  }

  get(id: string): WaitlistEntry {
    const e = this.entries.get(id);
    if (!e) throw new WaitlistError(`unknown waitlist entry: ${id}`);
    return { ...e };
  }

  offer(id: string, at: string): WaitlistEntry {
    const e = this.mutable(id);
    if (e.status !== 'waiting') throw new WaitlistError(`waitlist entry ${id} is ${e.status}`);
    e.status = 'offered';
    e.offeredAt = at;
    return this.get(id);
  }

  /** Convert a prospect to a lead — records the leadId and closes the entry. */
  convert(id: string, at: string, leadId: string): WaitlistEntry {
    const e = this.mutable(id);
    if (e.status === 'converted' || e.status === 'withdrawn') throw new WaitlistError(`waitlist entry ${id} is ${e.status}`);
    e.status = 'converted';
    e.convertedAt = at;
    e.leadId = leadId;
    return this.get(id);
  }

  withdraw(id: string): WaitlistEntry {
    const e = this.mutable(id);
    if (e.status === 'converted') throw new WaitlistError(`waitlist entry ${id} has already converted`);
    e.status = 'withdrawn';
    return this.get(id);
  }

  /** The active queue (waiting + offered) for a floorplan, FIFO by join time.
   *  Omit typeId for the whole tenant's active queue. */
  queue(tenantId: string, typeId?: string): WaitlistEntry[] {
    return [...this.entries.values()]
      .filter((e) => e.tenantId === tenantId && (e.status === 'waiting' || e.status === 'offered') && (typeId === undefined || e.typeId === typeId))
      .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt) || a.id.localeCompare(b.id))
      .map((e) => this.get(e.id));
  }

  /** 1-based position of an entry within its floorplan's active queue (0 if not queued). */
  position(id: string): number {
    const e = this.entries.get(id);
    if (!e) return 0;
    const idx = this.queue(e.tenantId, e.typeId).findIndex((x) => x.id === id);
    return idx < 0 ? 0 : idx + 1;
  }

  list(tenantId: string): WaitlistEntry[] {
    return [...this.entries.values()].filter((e) => e.tenantId === tenantId).map((e) => this.get(e.id));
  }

  private mutable(id: string): WaitlistEntry {
    const e = this.entries.get(id);
    if (!e) throw new WaitlistError(`unknown waitlist entry: ${id}`);
    return e;
  }
}
