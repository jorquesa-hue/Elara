// Utility billing / RUBS (Ratio Utility Billing System) — the operator receives
// a master utility bill for a property (water, sewer, trash, gas, electric) and
// recovers the cost from residents by allocating it across the active leases by
// a ratio: equal share, by occupancy, by unit area, or by bedroom count. The
// allocation is a PURE function that always sums back to the exact master total
// (rounding remainder carried onto the last share). The "bill residents" step
// lives in the App and raises a resident invoice per share through the SAME
// gated invoice.issue path (no bypass) — this module only MODELS + allocates.

export type UtilityKind = 'water' | 'sewer' | 'trash' | 'gas' | 'electric' | 'other';
export type AllocationMethod = 'equal' | 'occupancy' | 'area' | 'bedrooms';
export type UtilityBillStatus = 'draft' | 'billed';

export interface UtilityBill {
  id: string;
  tenantId: string;
  propertyId: string;
  utility: UtilityKind;
  periodStart: string; // ISO date
  periodEnd: string; // ISO date (exclusive)
  totalCents: number; // the master bill amount to recover
  method: AllocationMethod;
  status: UtilityBillStatus;
  createdAt: string;
  billedAt?: string;
  notes?: string;
}

/** A single lease's computed share of a utility bill. */
export interface UtilityShare {
  agreementId: string;
  unitId: string;
  basisValue: number; // the ratio weight used (headcount / sqm / bedrooms / 1)
  shareCents: number;
}

/** A participant lease with the raw ratio inputs; the method selects the weight. */
export interface UtilityParticipant {
  agreementId: string;
  unitId: string;
  occupancy?: number; // resident headcount on the lease
  area?: number; // unit area (sqm)
  bedrooms?: number; // unit bedroom count
}

export class UtilityBillError extends Error {}

const UTILITIES = new Set<UtilityKind>(['water', 'sewer', 'trash', 'gas', 'electric', 'other']);
const METHODS = new Set<AllocationMethod>(['equal', 'occupancy', 'area', 'bedrooms']);

export function isUtilityKind(x: string): x is UtilityKind { return UTILITIES.has(x as UtilityKind); }
export function isAllocationMethod(x: string): x is AllocationMethod { return METHODS.has(x as AllocationMethod); }

/** The ratio weight for a participant under a method — never below 1 for the
 *  proportional methods, so no active lease is allocated a zero share (a studio
 *  with 0 bedrooms still pays its part; equal weights everyone the same). */
function weightFor(p: UtilityParticipant, method: AllocationMethod): number {
  switch (method) {
    case 'equal': return 1;
    case 'occupancy': return Math.max(1, Math.floor(p.occupancy ?? 1));
    case 'area': return Math.max(1, p.area ?? 1);
    case 'bedrooms': return Math.max(1, Math.floor(p.bedrooms ?? 1));
  }
}

/**
 * Allocate a master total across participants by the chosen ratio. Each share is
 * floor(total * weight / sumWeights); the rounding remainder is carried onto the
 * LAST share so the shares sum EXACTLY to totalCents (never over- or under-bill).
 * Returns [] for no participants (the caller reports "nothing to bill").
 */
export function allocateUtility(totalCents: number, method: AllocationMethod, participants: readonly UtilityParticipant[]): UtilityShare[] {
  if (participants.length === 0) return [];
  const weights = participants.map((p) => weightFor(p, method));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const shares: UtilityShare[] = participants.map((p, i) => ({
    agreementId: p.agreementId,
    unitId: p.unitId,
    basisValue: weights[i]!,
    shareCents: Math.floor((totalCents * weights[i]!) / totalWeight),
  }));
  const allocated = shares.reduce((a, s) => a + s.shareCents, 0);
  const remainder = totalCents - allocated; // >= 0, < participants.length
  if (remainder !== 0) shares[shares.length - 1]!.shareCents += remainder;
  return shares;
}

export class UtilityBilling {
  private bills = new Map<string, UtilityBill>();

  hydrate(records: readonly UtilityBill[]): void {
    for (const r of records) this.bills.set(r.id, { ...r });
  }

  create(input: {
    id: string; tenantId: string; propertyId: string; utility: UtilityKind;
    periodStart: string; periodEnd: string; totalCents: number; method: AllocationMethod;
    createdAt: string; notes?: string;
  }): UtilityBill {
    if (this.bills.has(input.id)) throw new UtilityBillError(`duplicate utility bill: ${input.id}`);
    if (!input.propertyId) throw new UtilityBillError(`utility bill ${input.id}: propertyId is required`);
    if (!isUtilityKind(input.utility)) throw new UtilityBillError(`utility bill ${input.id}: unknown utility ${input.utility}`);
    if (!isAllocationMethod(input.method)) throw new UtilityBillError(`utility bill ${input.id}: unknown method ${input.method}`);
    if (!Number.isInteger(input.totalCents) || input.totalCents <= 0) throw new UtilityBillError(`utility bill ${input.id}: totalCents must be a positive integer`);
    if (!input.periodStart || !input.periodEnd) throw new UtilityBillError(`utility bill ${input.id}: period dates are required`);
    if (Date.parse(input.periodEnd.slice(0, 10)) <= Date.parse(input.periodStart.slice(0, 10))) throw new UtilityBillError(`utility bill ${input.id}: periodEnd must be after periodStart`);
    const b: UtilityBill = {
      id: input.id,
      tenantId: input.tenantId,
      propertyId: input.propertyId,
      utility: input.utility,
      periodStart: input.periodStart.slice(0, 10),
      periodEnd: input.periodEnd.slice(0, 10),
      totalCents: input.totalCents,
      method: input.method,
      status: 'draft',
      createdAt: input.createdAt,
      ...(input.notes ? { notes: input.notes } : {}),
    };
    this.bills.set(b.id, b);
    return this.get(b.id);
  }

  get(id: string): UtilityBill {
    const b = this.bills.get(id);
    if (!b) throw new UtilityBillError(`unknown utility bill: ${id}`);
    return { ...b };
  }

  markBilled(id: string, at: string): UtilityBill {
    const b = this.bills.get(id);
    if (!b) throw new UtilityBillError(`unknown utility bill: ${id}`);
    b.status = 'billed';
    b.billedAt = at;
    return this.get(id);
  }

  list(tenantId: string): UtilityBill[] {
    return [...this.bills.values()].filter((b) => b.tenantId === tenantId).map((b) => this.get(b.id));
  }
}
