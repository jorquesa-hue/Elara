// Bank reconciliation (#5), AR & AP. Bank transactions are imported and matched
// against the money the ledger already knows about — customer payments (inflow)
// and AP payments (outflow). suggestMatches() is a pure, deterministic ranker
// (exact signed amount + date proximity); it is the "AI-powered" seam — an LLM
// can re-rank or explain on top, but the kernel stays zero-dependency and its
// suggestions are reproducible and testable. Matching never moves money; it only
// links a bank line to an existing ledger event.

export type BankTxnStatus = 'unmatched' | 'matched' | 'ignored';
export type MatchTargetType = 'payment' | 'ap_payment';

export interface BankTransaction {
  id: string;
  tenantId: string;
  bankAccountId?: string;
  postedAt: string;
  amountCents: number; // signed: positive = inflow, negative = outflow
  description: string;
  reference?: string;
  status: BankTxnStatus;
  matchedType?: MatchTargetType;
  matchedId?: string;
  matchedAt?: string;
}

export interface MatchCandidate {
  type: MatchTargetType;
  id: string;
  amountCents: number; // signed to align with the bank sign convention
  at: string;
}

export interface MatchSuggestion {
  candidate: MatchCandidate;
  score: number;
  reason: string;
}

export class ReconciliationError extends Error {}

function daysApart(a: string, b: string): number {
  const ms = Math.abs(Date.parse(a) - Date.parse(b));
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms / 86_400_000;
}

/**
 * Rank candidates for a bank transaction: exact signed-amount match, within a
 * date window, closer dates scoring higher. Deterministic — no randomness.
 */
export function suggestMatches(
  txn: Pick<BankTransaction, 'amountCents' | 'postedAt'>,
  candidates: readonly MatchCandidate[],
  opts: { maxDays?: number } = {},
): MatchSuggestion[] {
  const maxDays = opts.maxDays ?? 5;
  const out: MatchSuggestion[] = [];
  for (const c of candidates) {
    if (c.amountCents !== txn.amountCents) continue;
    const d = daysApart(txn.postedAt, c.at);
    if (d > maxDays) continue;
    out.push({ candidate: c, score: Math.round(100 - d * 10), reason: `exact amount, ${d.toFixed(1)}d apart` });
  }
  return out.sort((a, b) => b.score - a.score || a.candidate.id.localeCompare(b.candidate.id));
}

export class Reconciliation {
  private txns = new Map<string, BankTransaction>();

  /** Load stored bank transactions for cold-start rehydration. */
  hydrate(records: readonly BankTransaction[]): void {
    for (const r of records) this.txns.set(r.id, { ...r });
  }

  import(input: {
    id: string;
    tenantId: string;
    postedAt: string;
    amountCents: number;
    description: string;
    bankAccountId?: string;
    reference?: string;
  }): BankTransaction {
    if (this.txns.has(input.id)) throw new ReconciliationError(`duplicate bank transaction: ${input.id}`);
    if (!Number.isInteger(input.amountCents) || input.amountCents === 0) {
      throw new ReconciliationError(`bank transaction ${input.id}: amountCents must be a non-zero integer`);
    }
    const rec: BankTransaction = {
      id: input.id,
      tenantId: input.tenantId,
      bankAccountId: input.bankAccountId,
      postedAt: input.postedAt,
      amountCents: input.amountCents,
      description: input.description,
      reference: input.reference,
      status: 'unmatched',
    };
    this.txns.set(rec.id, rec);
    return { ...rec };
  }

  get(id: string): BankTransaction {
    const t = this.txns.get(id);
    if (!t) throw new ReconciliationError(`unknown bank transaction: ${id}`);
    return { ...t };
  }

  /** Link a bank line to a payment / AP payment. */
  match(id: string, type: MatchTargetType, targetId: string, at: string): BankTransaction {
    const t = this.txns.get(id);
    if (!t) throw new ReconciliationError(`unknown bank transaction: ${id}`);
    if (t.status === 'matched') throw new ReconciliationError(`bank transaction ${id} is already matched`);
    t.status = 'matched';
    t.matchedType = type;
    t.matchedId = targetId;
    t.matchedAt = at;
    return { ...t };
  }

  unmatch(id: string): BankTransaction {
    const t = this.txns.get(id);
    if (!t) throw new ReconciliationError(`unknown bank transaction: ${id}`);
    t.status = 'unmatched';
    t.matchedType = undefined;
    t.matchedId = undefined;
    t.matchedAt = undefined;
    return { ...t };
  }

  ignore(id: string): BankTransaction {
    const t = this.txns.get(id);
    if (!t) throw new ReconciliationError(`unknown bank transaction: ${id}`);
    if (t.status === 'matched') throw new ReconciliationError(`bank transaction ${id} is matched; unmatch first`);
    t.status = 'ignored';
    return { ...t };
  }

  list(tenantId: string, filter: { status?: BankTxnStatus } = {}): BankTransaction[] {
    return [...this.txns.values()]
      .filter((t) => t.tenantId === tenantId && (filter.status === undefined || t.status === filter.status))
      .map((t) => ({ ...t }));
  }

  summary(tenantId: string) {
    const mine = this.list(tenantId);
    const by = (s: BankTxnStatus) => mine.filter((t) => t.status === s);
    const unmatched = by('unmatched');
    return {
      total: mine.length,
      unmatched: unmatched.length,
      matched: by('matched').length,
      ignored: by('ignored').length,
      unmatchedAmountCents: unmatched.reduce((s, t) => s + t.amountCents, 0),
    };
  }

  all(): readonly BankTransaction[] {
    return [...this.txns.values()].map((t) => ({ ...t }));
  }
}
