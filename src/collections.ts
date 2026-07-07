// Collections: the escalation ladder for overdue invoices. The STAGES array is
// a source-of-truth TypeScript array (invariant 5) whose action maps into a
// policy action — remind/late_fee are routine, suspend/evict escalate. Late
// fees post real revenue; suspend and evict never execute from the kernel.

export type CollectionAction = 'remind' | 'late_fee' | 'suspend' | 'evict';

export interface CollectionStage {
  id: string;
  minDaysOverdue: number;
  action: CollectionAction;
  /** Policy action string decided by PolicyEnvelope before execution. */
  policyAction: string;
  description: string;
  /** For late_fee stages: fee as basis points of the outstanding balance. */
  feeBps?: number;
}

// Ordered by escalating severity; gen-seed mirrors these into SQL.
export const COLLECTION_STAGES: readonly CollectionStage[] = [
  { id: 'col-remind-1', minDaysOverdue: 1, action: 'remind', policyAction: 'collections.remind', description: 'Friendly reminder, 1 day overdue.' },
  { id: 'col-remind-2', minDaysOverdue: 7, action: 'remind', policyAction: 'collections.remind', description: 'Second reminder, 1 week overdue.' },
  { id: 'col-latefee', minDaysOverdue: 10, action: 'late_fee', policyAction: 'collections.late_fee', description: 'Assess 2% contractual late fee.', feeBps: 200 },
  { id: 'col-suspend', minDaysOverdue: 20, action: 'suspend', policyAction: 'collections.suspend', description: 'Suspend non-essential services (human confirms).' },
  { id: 'col-evict', minDaysOverdue: 45, action: 'evict', policyAction: 'collections.evict', description: 'Begin eviction (regulated, human-only).' },
] as const;

export class CollectionsError extends Error {}

/** Highest-severity stage whose threshold the overdue age has reached. */
export function stageFor(daysOverdue: number): CollectionStage | null {
  let match: CollectionStage | null = null;
  for (const stage of COLLECTION_STAGES) {
    if (daysOverdue >= stage.minDaysOverdue) match = stage;
  }
  return match;
}

export function lateFeeCents(balanceCents: number, feeBps: number): number {
  if (balanceCents < 0) throw new CollectionsError('balance cannot be negative');
  return Math.round((balanceCents * feeBps) / 10_000);
}
