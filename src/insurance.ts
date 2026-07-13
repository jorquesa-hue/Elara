// Renters-insurance compliance — residents on a lease must carry liability
// coverage, and the operator has to know at a glance who is covered, whose
// policy is about to lapse, and who has none. A PURE, zero-dep tenant-scoped
// registry of policies keyed to an agreement (a lease); the coverage
// classification is a pure function of the policies + a date, so the report
// and the resident portal read the same answer. No money moves here, so this
// is RBAC-only (no PolicyEnvelope action) — a liability-tracking record, not a
// regulated transaction.

export type InsuranceStatus = 'active' | 'expired' | 'cancelled';

export interface InsurancePolicy {
  id: string;
  tenantId: string;
  agreementId: string; // the lease the coverage is attached to
  partyId?: string; // the insured resident (optional)
  carrier: string;
  policyNumber: string;
  liabilityCents: number; // liability coverage amount (0 allowed for a stub)
  effectiveAt: string; // ISO date coverage begins
  expiresAt: string; // ISO date coverage ends (exclusive)
  status: InsuranceStatus;
  verifiedAt?: string; // when the operator verified the certificate
  notes?: string;
  createdAt: string;
}

export class InsuranceError extends Error {}

/** Coverage classification of an agreement as of a date. */
export type CoverageStatus = 'compliant' | 'expiring' | 'lapsed' | 'none';

const DAY = 86_400_000;
const dayMs = (iso: string) => Date.parse(iso.slice(0, 10));

/** Is a policy in force on `asOf`? (active status and asOf within [effective, expires).) */
export function policyInForce(p: InsurancePolicy, asOf: string): boolean {
  if (p.status !== 'active') return false;
  const at = dayMs(asOf), from = dayMs(p.effectiveAt), to = dayMs(p.expiresAt);
  if (Number.isNaN(at) || Number.isNaN(from) || Number.isNaN(to)) return false;
  return from <= at && at < to;
}

/**
 * Classify an agreement's coverage from its policies as of `asOf`:
 *  - compliant: an in-force policy that is not expiring within `expiringWithinDays`
 *  - expiring:  an in-force policy expiring within the window (still covered, act soon)
 *  - lapsed:    a policy exists but none is in force (all expired/cancelled)
 *  - none:      no policy on record
 */
export function coverageStatus(
  policies: readonly InsurancePolicy[],
  asOf: string,
  expiringWithinDays = 30,
): CoverageStatus {
  if (policies.length === 0) return 'none';
  const inForce = policies.filter((p) => policyInForce(p, asOf));
  if (inForce.length === 0) return 'lapsed';
  const at = dayMs(asOf);
  // Take the latest expiry among in-force policies — that is the effective cover-through.
  const coverThrough = Math.max(...inForce.map((p) => dayMs(p.expiresAt)));
  return coverThrough - at <= expiringWithinDays * DAY ? 'expiring' : 'compliant';
}

export class InsuranceRegistry {
  private policies = new Map<string, InsurancePolicy>();

  hydrate(records: readonly InsurancePolicy[]): void {
    for (const r of records) this.policies.set(r.id, { ...r });
  }

  create(input: {
    id: string; tenantId: string; agreementId: string; carrier: string; policyNumber: string;
    liabilityCents: number; effectiveAt: string; expiresAt: string; createdAt: string;
    partyId?: string; status?: InsuranceStatus; notes?: string;
  }): InsurancePolicy {
    if (this.policies.has(input.id)) throw new InsuranceError(`duplicate insurance policy: ${input.id}`);
    if (!input.agreementId) throw new InsuranceError(`insurance policy ${input.id}: agreementId is required`);
    if (!input.carrier) throw new InsuranceError(`insurance policy ${input.id}: carrier is required`);
    if (!input.policyNumber) throw new InsuranceError(`insurance policy ${input.id}: policyNumber is required`);
    if (!Number.isInteger(input.liabilityCents) || input.liabilityCents < 0) throw new InsuranceError(`insurance policy ${input.id}: liabilityCents must be a non-negative integer`);
    if (!input.effectiveAt || !input.expiresAt) throw new InsuranceError(`insurance policy ${input.id}: effectiveAt and expiresAt are required`);
    if (dayMs(input.expiresAt) <= dayMs(input.effectiveAt)) throw new InsuranceError(`insurance policy ${input.id}: expiresAt must be after effectiveAt`);
    const p: InsurancePolicy = {
      id: input.id,
      tenantId: input.tenantId,
      agreementId: input.agreementId,
      carrier: input.carrier,
      policyNumber: input.policyNumber,
      liabilityCents: input.liabilityCents,
      effectiveAt: input.effectiveAt.slice(0, 10),
      expiresAt: input.expiresAt.slice(0, 10),
      status: input.status ?? 'active',
      createdAt: input.createdAt,
      ...(input.partyId ? { partyId: input.partyId } : {}),
      ...(input.notes ? { notes: input.notes } : {}),
    };
    this.policies.set(p.id, p);
    return this.get(p.id);
  }

  get(id: string): InsurancePolicy {
    const p = this.policies.get(id);
    if (!p) throw new InsuranceError(`unknown insurance policy: ${id}`);
    return { ...p };
  }

  /** Stamp operator verification of the certificate. */
  verify(id: string, at: string): InsurancePolicy {
    const p = this.mutable(id);
    p.verifiedAt = at;
    return this.get(id);
  }

  cancel(id: string): InsurancePolicy {
    const p = this.mutable(id);
    p.status = 'cancelled';
    return this.get(id);
  }

  forAgreement(agreementId: string): InsurancePolicy[] {
    return [...this.policies.values()].filter((p) => p.agreementId === agreementId).map((p) => this.get(p.id));
  }

  /** The in-force policy for an agreement as of `asOf`, if any (latest expiry wins). */
  inForce(agreementId: string, asOf: string): InsurancePolicy | undefined {
    const covering = this.forAgreement(agreementId).filter((p) => policyInForce(p, asOf));
    if (covering.length === 0) return undefined;
    return covering.sort((a, b) => dayMs(b.expiresAt) - dayMs(a.expiresAt))[0];
  }

  list(tenantId: string): InsurancePolicy[] {
    return [...this.policies.values()].filter((p) => p.tenantId === tenantId).map((p) => this.get(p.id));
  }

  private mutable(id: string): InsurancePolicy {
    const p = this.policies.get(id);
    if (!p) throw new InsuranceError(`unknown insurance policy: ${id}`);
    return p;
  }
}
