// Bank accounts — the operating vs TRUST distinction many jurisdictions require
// for security deposits. Deposit cash must not commingle with operating cash: a
// trust bank account has its OWN GL cash account, so deposits book there and are
// visible as segregated on the books. A PURE, zero-dep tenant-scoped registry;
// the App routes deposit postings to a tenant's trust account when one exists.

export type BankAccountKind = 'operating' | 'trust';

export interface BankAccountRecord {
  id: string;
  tenantId: string;
  code: string; // e.g. "TRUST-01"
  name: string; // e.g. "Resident Deposits Trust — First National"
  kind: BankAccountKind;
  glAccount: string; // the ledger cash account this bank account maps to
  entityId?: string; // owning legal entity, when segregated per SPE
}

export class BankAccountError extends Error {}

export class BankAccounts {
  private byId = new Map<string, BankAccountRecord>();

  add(rec: BankAccountRecord): BankAccountRecord {
    if (this.byId.has(rec.id)) throw new BankAccountError(`duplicate bank account: ${rec.id}`);
    if (!rec.code) throw new BankAccountError(`bank account ${rec.id}: code is required`);
    if (rec.kind !== 'operating' && rec.kind !== 'trust') throw new BankAccountError(`bank account ${rec.id}: kind must be operating|trust`);
    for (const r of this.byId.values()) {
      if (r.tenantId === rec.tenantId && r.code === rec.code) throw new BankAccountError(`bank account code '${rec.code}' already used in tenant ${rec.tenantId}`);
    }
    this.byId.set(rec.id, { ...rec });
    return { ...rec };
  }

  get(tenantId: string, id: string): BankAccountRecord | null {
    const r = this.byId.get(id);
    return r && r.tenantId === tenantId ? { ...r } : null;
  }

  list(tenantId: string): BankAccountRecord[] {
    return [...this.byId.values()].filter((r) => r.tenantId === tenantId).map((r) => ({ ...r }));
  }

  /** The tenant's trust account (first one), if any — where deposit cash books. */
  trustFor(tenantId: string, entityId?: string): BankAccountRecord | null {
    const trusts = this.list(tenantId).filter((r) => r.kind === 'trust');
    if (entityId) { const scoped = trusts.find((r) => r.entityId === entityId); if (scoped) return scoped; }
    return trusts[0] ?? null;
  }

  /** Load stored records for cold-start rehydration. */
  hydrate(records: readonly BankAccountRecord[]): void {
    for (const r of records) this.byId.set(r.id, { ...r });
  }
}
