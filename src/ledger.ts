// Double-entry ledger. Journal lines are append-only (invariant 1) and every
// entry must balance (invariant 6). The DB trigger is the enforcement of
// record; this service asserts additionally so violations fail fast in-process.

export interface JournalLine {
  entryId: string;
  account: string;
  debitCents: number;
  creditCents: number;
  currency: string;
  agreementId?: string;
  memo?: string;
  postedAt: string; // ISO-8601
}

export interface JournalEntryInput {
  entryId: string;
  postedAt: string;
  currency?: string;
  agreementId?: string;
  memo?: string;
  lines: Array<{
    account: string;
    debitCents?: number;
    creditCents?: number;
    memo?: string;
  }>;
}

export class LedgerError extends Error {}

export class Ledger {
  private lines: JournalLine[] = [];
  private entryIds = new Set<string>();

  post(input: JournalEntryInput): readonly JournalLine[] {
    if (this.entryIds.has(input.entryId)) {
      throw new LedgerError(`duplicate entry id: ${input.entryId}`);
    }
    if (input.lines.length < 2) {
      throw new LedgerError(`entry ${input.entryId} needs at least two lines`);
    }
    const currency = input.currency ?? 'BRL';
    let debits = 0;
    let credits = 0;
    const staged: JournalLine[] = input.lines.map((l) => {
      const debitCents = l.debitCents ?? 0;
      const creditCents = l.creditCents ?? 0;
      if (!Number.isInteger(debitCents) || !Number.isInteger(creditCents)) {
        throw new LedgerError(`entry ${input.entryId}: amounts must be integer cents`);
      }
      if (debitCents < 0 || creditCents < 0) {
        throw new LedgerError(`entry ${input.entryId}: negative amounts are not allowed`);
      }
      if ((debitCents > 0) === (creditCents > 0)) {
        throw new LedgerError(
          `entry ${input.entryId}: each line must be exactly one of debit or credit`,
        );
      }
      debits += debitCents;
      credits += creditCents;
      return Object.freeze({
        entryId: input.entryId,
        account: l.account,
        debitCents,
        creditCents,
        currency,
        agreementId: input.agreementId,
        memo: l.memo ?? input.memo,
        postedAt: input.postedAt,
      });
    });
    if (debits !== credits) {
      throw new LedgerError(
        `entry ${input.entryId} does not balance: debits ${debits} != credits ${credits}`,
      );
    }
    this.entryIds.add(input.entryId);
    this.lines.push(...staged);
    return staged;
  }

  /** Debit-positive balance for one account. */
  balance(account: string): number {
    return this.lines
      .filter((l) => l.account === account)
      .reduce((sum, l) => sum + l.debitCents - l.creditCents, 0);
  }

  trialBalance(): Map<string, number> {
    const tb = new Map<string, number>();
    for (const l of this.lines) {
      tb.set(l.account, (tb.get(l.account) ?? 0) + l.debitCents - l.creditCents);
    }
    return tb;
  }

  assertBalanced(): void {
    let net = 0;
    for (const v of this.trialBalance().values()) net += v;
    if (net !== 0) throw new LedgerError(`ledger out of balance by ${net} cents`);
  }

  linesFor(filter: { account?: string; agreementId?: string } = {}): readonly JournalLine[] {
    return this.lines.filter(
      (l) =>
        (filter.account === undefined || l.account === filter.account) &&
        (filter.agreementId === undefined || l.agreementId === filter.agreementId),
    );
  }

  get allLines(): readonly JournalLine[] {
    return [...this.lines];
  }
}
