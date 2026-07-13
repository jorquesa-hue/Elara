// Period close / posting locks — the hard month-end every fund-grade book needs.
// Once an accounting period is CLOSED, no journal entry may post into it, so the
// numbers a fund or owner was given can never silently change. Closing is a
// normal finance action; RE-OPENING a closed period is a regulated restatement
// and is policy-gated (escalate) at the API layer. This module is a PURE,
// zero-dep registry keyed by tenant × period ('YYYY-MM'); enforcement is a guard
// the Ledger calls before every post().

export type PeriodStatus = 'closed' | 'open';

export interface PeriodLockRecord {
  tenantId: string;
  period: string; // 'YYYY-MM'
  status: PeriodStatus;
  closedAt?: string;
  closedBy?: string;
  reopenedAt?: string;
  reopenedBy?: string;
}

export class PeriodLockError extends Error {}

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** The 'YYYY-MM' period an ISO timestamp/date falls in. */
export function periodOf(postedAt: string): string {
  return postedAt.slice(0, 7);
}

export class PeriodLock {
  private byKey = new Map<string, PeriodLockRecord>(); // key: `${tenantId}:${period}`

  private key(tenantId: string, period: string): string {
    return `${tenantId}:${period}`;
  }

  private assertPeriod(period: string): void {
    if (!PERIOD_RE.test(period)) throw new PeriodLockError(`invalid period '${period}' (expected YYYY-MM)`);
  }

  /** Close a period. Idempotent: re-closing an already-closed period is a no-op. */
  close(tenantId: string, period: string, at: string, by: string): PeriodLockRecord {
    this.assertPeriod(period);
    const rec: PeriodLockRecord = { tenantId, period, status: 'closed', closedAt: at, closedBy: by };
    this.byKey.set(this.key(tenantId, period), rec);
    return { ...rec };
  }

  /** Re-open a closed period (regulated restatement — the caller policy-gates it). */
  reopen(tenantId: string, period: string, at: string, by: string): PeriodLockRecord {
    this.assertPeriod(period);
    const existing = this.byKey.get(this.key(tenantId, period));
    if (!existing || existing.status !== 'closed') throw new PeriodLockError(`period ${period} is not closed`);
    const rec: PeriodLockRecord = { ...existing, status: 'open', reopenedAt: at, reopenedBy: by };
    this.byKey.set(this.key(tenantId, period), rec);
    return { ...rec };
  }

  isClosed(tenantId: string, postedAt: string): boolean {
    const rec = this.byKey.get(this.key(tenantId, periodOf(postedAt)));
    return rec?.status === 'closed';
  }

  /** Throw if the period of `postedAt` is closed for the tenant — the ledger guard. */
  assertOpen(tenantId: string, postedAt: string): void {
    if (this.isClosed(tenantId, postedAt)) {
      throw new PeriodLockError(`accounting period ${periodOf(postedAt)} is closed; reopen it before posting`);
    }
  }

  list(tenantId: string): PeriodLockRecord[] {
    return [...this.byKey.values()].filter((r) => r.tenantId === tenantId).map((r) => ({ ...r })).sort((a, b) => (a.period < b.period ? 1 : -1));
  }

  all(): PeriodLockRecord[] {
    return [...this.byKey.values()].map((r) => ({ ...r }));
  }

  /** Load stored records for cold-start rehydration. */
  hydrate(records: readonly PeriodLockRecord[]): void {
    for (const r of records) this.byKey.set(this.key(r.tenantId, r.period), { ...r });
  }
}
