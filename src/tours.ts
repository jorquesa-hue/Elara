// Tour scheduling — the top of the leasing funnel that turns an interested lead
// into a walked unit. A prospect requests a tour of a unit at a time; the office
// confirms it, then marks it completed (advancing the lead to 'toured'), a
// no-show, or cancelled. A PURE, zero-dep state machine, tenant-scoped, in the
// same shape as applications so persistence and the App wiring stay uniform.

export type TourStatus = 'requested' | 'confirmed' | 'completed' | 'cancelled' | 'no_show';

export interface Tour {
  id: string;
  tenantId: string;
  leadId?: string;
  unitId?: string;
  prospectName: string;
  prospectEmail?: string;
  scheduledAt: string; // ISO datetime the tour is booked for
  status: TourStatus;
  agentId?: string; // the leasing agent hosting it
  notes?: string;
  createdAt: string;
  completedAt?: string;
  cancelReason?: string;
}

export class TourError extends Error {}

export class Tours {
  private tours = new Map<string, Tour>();

  hydrate(records: readonly Tour[]): void {
    for (const r of records) this.tours.set(r.id, { ...r });
  }

  request(input: { id: string; tenantId: string; prospectName: string; scheduledAt: string; createdAt: string; prospectEmail?: string; leadId?: string; unitId?: string; agentId?: string; notes?: string }): Tour {
    if (this.tours.has(input.id)) throw new TourError(`duplicate tour: ${input.id}`);
    if (!input.prospectName) throw new TourError(`tour ${input.id}: prospectName is required`);
    if (!input.scheduledAt) throw new TourError(`tour ${input.id}: scheduledAt is required`);
    const tour: Tour = {
      id: input.id,
      tenantId: input.tenantId,
      prospectName: input.prospectName,
      scheduledAt: input.scheduledAt,
      status: 'requested',
      createdAt: input.createdAt,
      ...(input.prospectEmail ? { prospectEmail: input.prospectEmail } : {}),
      ...(input.leadId ? { leadId: input.leadId } : {}),
      ...(input.unitId ? { unitId: input.unitId } : {}),
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.notes ? { notes: input.notes } : {}),
    };
    this.tours.set(tour.id, tour);
    return this.get(tour.id);
  }

  get(id: string): Tour {
    const t = this.tours.get(id);
    if (!t) throw new TourError(`unknown tour: ${id}`);
    return { ...t };
  }

  confirm(id: string, agentId?: string): Tour {
    const t = this.mutable(id);
    if (t.status !== 'requested') throw new TourError(`tour ${id} is ${t.status}; only a requested tour can be confirmed`);
    t.status = 'confirmed';
    if (agentId) t.agentId = agentId;
    return this.get(id);
  }

  complete(id: string, at: string, notes?: string): Tour {
    const t = this.mutable(id);
    if (t.status !== 'requested' && t.status !== 'confirmed') throw new TourError(`tour ${id} is ${t.status}; cannot complete`);
    t.status = 'completed';
    t.completedAt = at;
    if (notes) t.notes = notes;
    return this.get(id);
  }

  noShow(id: string, at: string): Tour {
    const t = this.mutable(id);
    if (t.status !== 'requested' && t.status !== 'confirmed') throw new TourError(`tour ${id} is ${t.status}; cannot mark no-show`);
    t.status = 'no_show';
    t.completedAt = at;
    return this.get(id);
  }

  cancel(id: string, reason?: string): Tour {
    const t = this.mutable(id);
    if (t.status === 'completed' || t.status === 'cancelled') throw new TourError(`tour ${id} is ${t.status}; cannot cancel`);
    t.status = 'cancelled';
    if (reason) t.cancelReason = reason;
    return this.get(id);
  }

  list(tenantId: string): Tour[] {
    return [...this.tours.values()].filter((t) => t.tenantId === tenantId).map((t) => ({ ...t }));
  }

  private mutable(id: string): Tour {
    const t = this.tours.get(id);
    if (!t) throw new TourError(`unknown tour: ${id}`);
    return t;
  }
}
