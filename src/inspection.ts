// Move-in / move-out inspections (vistoria, #18/#19). An inspection is scheduled
// against an agreement (and usually a space), then completed with a per-area
// condition checklist and an optional damage estimate. The damage estimate feeds
// the move-out deposit refund (the operator deducts it) — but the money itself
// flows through the existing deposit/AP path; this module owns only the
// inspection record and its lifecycle.

export type InspectionKind = 'move_in' | 'move_out';
export type InspectionStatus = 'scheduled' | 'completed' | 'cancelled';
export type ItemCondition = 'ok' | 'wear' | 'damaged' | 'missing';

export interface InspectionItem {
  area: string; // "kitchen", "bathroom", "bed A", …
  condition: ItemCondition;
  note?: string;
}

export interface InspectionRecord {
  id: string;
  tenantId: string;
  agreementId: string;
  spaceId?: string;
  kind: InspectionKind;
  status: InspectionStatus;
  scheduledAt?: string;
  conductedAt?: string;
  conductedByPartyId?: string;
  items: InspectionItem[];
  damageCents?: number; // estimated cost of damage found — informs the refund
  createdAt: string;
}

export class InspectionError extends Error {}

export class Inspections {
  private byId = new Map<string, InspectionRecord>();

  /** Load stored inspections for cold-start rehydration. */
  hydrate(records: readonly InspectionRecord[]): void {
    for (const r of records) this.byId.set(r.id, { ...r, items: r.items.map((i) => ({ ...i })) });
  }

  schedule(input: {
    id: string;
    tenantId: string;
    agreementId: string;
    kind: InspectionKind;
    createdAt: string;
    spaceId?: string;
    scheduledAt?: string;
  }): InspectionRecord {
    if (this.byId.has(input.id)) throw new InspectionError(`duplicate inspection: ${input.id}`);
    if (input.kind !== 'move_in' && input.kind !== 'move_out') {
      throw new InspectionError(`inspection ${input.id}: kind must be move_in|move_out`);
    }
    const rec: InspectionRecord = {
      id: input.id,
      tenantId: input.tenantId,
      agreementId: input.agreementId,
      spaceId: input.spaceId,
      kind: input.kind,
      status: 'scheduled',
      scheduledAt: input.scheduledAt,
      items: [],
      createdAt: input.createdAt,
    };
    this.byId.set(rec.id, rec);
    return { ...rec, items: [] };
  }

  get(id: string): InspectionRecord {
    const r = this.byId.get(id);
    if (!r) throw new InspectionError(`unknown inspection: ${id}`);
    return { ...r, items: r.items.map((i) => ({ ...i })) };
  }

  /** Complete an inspection with its checklist and (for move-out) a damage estimate. */
  complete(
    id: string,
    at: string,
    input: { items: InspectionItem[]; damageCents?: number; conductedByPartyId?: string },
  ): InspectionRecord {
    const r = this.byId.get(id);
    if (!r) throw new InspectionError(`unknown inspection: ${id}`);
    if (r.status !== 'scheduled') throw new InspectionError(`inspection ${id} is ${r.status}; cannot complete`);
    if (input.damageCents !== undefined && (!Number.isInteger(input.damageCents) || input.damageCents < 0)) {
      throw new InspectionError(`inspection ${id}: damageCents must be a non-negative integer`);
    }
    r.status = 'completed';
    r.conductedAt = at;
    r.conductedByPartyId = input.conductedByPartyId;
    r.items = input.items.map((i) => ({ ...i }));
    r.damageCents = input.damageCents;
    return this.get(id);
  }

  cancel(id: string, _at: string): InspectionRecord {
    const r = this.byId.get(id);
    if (!r) throw new InspectionError(`unknown inspection: ${id}`);
    if (r.status === 'completed') throw new InspectionError(`inspection ${id} is completed; cannot cancel`);
    r.status = 'cancelled';
    return this.get(id);
  }

  forAgreement(agreementId: string): InspectionRecord[] {
    return [...this.byId.values()].filter((r) => r.agreementId === agreementId).map((r) => this.get(r.id));
  }

  list(tenantId: string): InspectionRecord[] {
    return [...this.byId.values()].filter((r) => r.tenantId === tenantId).map((r) => this.get(r.id));
  }

  all(): readonly InspectionRecord[] {
    return [...this.byId.values()].map((r) => this.get(r.id));
  }
}
