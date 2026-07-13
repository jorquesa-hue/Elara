// Lease renewals — the retention arm of the leasing engine. A lease that runs
// to its end date without a renewal offer becomes an avoidable move-out, so an
// operator sweeps the book for agreements approaching expiry and puts a renewal
// offer (a proposed new rent + extended term) in front of each resident before
// they walk. This module is the PURE, zero-dep computation: renewalsDue() folds
// the active book + a renewal policy into a prioritized offer list; the offer is
// DETERMINISTIC from the agreement + policy, so it needs no storage of its own —
// the App recomputes it on demand, notifies on the sweep (idempotent via a
// per-agreement marker thread, like the collections sweep), and ACCEPTING an
// offer applies through the normal agreement rent-adjust + term-amend paths.

export interface RenewalPolicy {
  /** Offer a renewal when the lease ends within this many days. */
  lookaheadDays: number;
  /** Rent escalation applied to the renewal, in basis points (500 = +5%). */
  escalationBps: number;
  /** The renewed term length in months. */
  termMonths: number;
}

export const DEFAULT_RENEWAL_POLICY: RenewalPolicy = { lookaheadDays: 90, escalationBps: 500, termMonths: 12 };

export interface RenewalCandidate {
  id: string;
  kind: string; // nightly | monthly | lease
  status: string;
  rateCents: number;
  end: string; // ISO date
  residentName?: string;
}

export interface RenewalOffer {
  agreementId: string;
  residentName?: string;
  kind: string;
  currentRateCents: number;
  proposedRateCents: number;
  currentEnd: string;
  proposedEnd: string;
  daysToExpiry: number;
}

/** Escalate a rent by basis points (rounded to whole cents). */
export function proposedRate(currentCents: number, escalationBps: number): number {
  return Math.round(currentCents * (10000 + escalationBps) / 10000);
}

/** Add `months` to an ISO date (YYYY-MM-DD), clamping the day to month length. */
export function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map((n) => parseInt(n, 10));
  if (!y || !m || !d) return iso;
  const total = (m - 1) + months;
  const ny = y + Math.floor(total / 12);
  const nm = ((total % 12) + 12) % 12; // 0-based month
  const lastDay = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  const nd = Math.min(d, lastDay);
  return `${String(ny).padStart(4, '0')}-${String(nm + 1).padStart(2, '0')}-${String(nd).padStart(2, '0')}`;
}

/** Whole days from `at` to `end` (negative if already past). */
export function daysUntil(at: string, end: string): number {
  const a = Date.parse(at.slice(0, 10));
  const b = Date.parse(end.slice(0, 10));
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86400000);
}

/** The renewal offers due for the active book at time `at`, prioritized by how
 *  soon each lease expires (soonest first). Only active, term-based agreements
 *  (monthly/lease) that expire within the lookahead window are offered. Pure. */
export function renewalsDue(candidates: readonly RenewalCandidate[], at: string, policy: RenewalPolicy = DEFAULT_RENEWAL_POLICY): RenewalOffer[] {
  const offers: RenewalOffer[] = [];
  for (const c of candidates) {
    if (c.status !== 'active') continue;
    if (c.kind !== 'lease' && c.kind !== 'monthly') continue;
    const days = daysUntil(at, c.end);
    if (days < 0 || days > policy.lookaheadDays) continue;
    offers.push({
      agreementId: c.id,
      ...(c.residentName ? { residentName: c.residentName } : {}),
      kind: c.kind,
      currentRateCents: c.rateCents,
      proposedRateCents: proposedRate(c.rateCents, policy.escalationBps),
      currentEnd: c.end,
      proposedEnd: addMonths(c.end, policy.termMonths),
      daysToExpiry: days,
    });
  }
  return offers.sort((a, b) => a.daysToExpiry - b.daysToExpiry || a.agreementId.localeCompare(b.agreementId));
}
