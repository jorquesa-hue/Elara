// Party — a person or organization, related to agreements by role. Generalises
// the single guest into a directory where the same party can be resident on one
// lease, guarantor on another, and a payee we owe on a third. This is the anchor
// for financial-responsible ≠ resident (#10), roommate matching (#9), CRM leads
// (#17), and the payee side of accounts payable (#22). Tenant-scoped and
// id-stable so it maps cleanly onto API payloads and reporting rows.

export type PartyKind = 'person' | 'organization';

export type AgreementRole =
  | 'resident'
  | 'financial_responsible'
  | 'guarantor'
  | 'cosigner'
  | 'occupant'
  | 'prospect'
  | 'payee';

export const AGREEMENT_ROLES: readonly AgreementRole[] = [
  'resident', 'financial_responsible', 'guarantor', 'cosigner', 'occupant', 'prospect', 'payee',
];

export interface PartyRecord {
  id: string;
  tenantId: string;
  kind: PartyKind;
  displayName: string;
  legalName?: string;
  taxId?: string; // CPF / CNPJ / foreign tax id
  email?: string;
  phone?: string;
  attributes?: Record<string, unknown>; // KYC, student questionnaire, etc.
}

export interface AgreementPartyRecord {
  agreementId: string;
  partyId: string;
  role: AgreementRole;
  sharePct?: number; // split responsibility, 0..100
  from?: string;
  to?: string; // set when the role ends; open links have no `to`
}

export class PartyError extends Error {}

/** Directory of parties plus their role links to agreements. */
export class PartyDirectory {
  private parties = new Map<string, PartyRecord>();
  private links: AgreementPartyRecord[] = [];

  addParty(rec: PartyRecord): PartyRecord {
    if (this.parties.has(rec.id)) throw new PartyError(`duplicate party: ${rec.id}`);
    if (!rec.displayName) throw new PartyError(`party ${rec.id}: displayName is required`);
    if (rec.kind !== 'person' && rec.kind !== 'organization') {
      throw new PartyError(`party ${rec.id}: kind must be person|organization`);
    }
    this.parties.set(rec.id, { ...rec });
    return { ...rec };
  }

  getParty(tenantId: string, id: string): PartyRecord | null {
    const p = this.parties.get(id);
    return p && p.tenantId === tenantId ? { ...p } : null;
  }

  listParties(tenantId: string): PartyRecord[] {
    return [...this.parties.values()].filter((p) => p.tenantId === tenantId).map((p) => ({ ...p }));
  }

  /** Attach a party to an agreement in a role. */
  assign(link: AgreementPartyRecord): AgreementPartyRecord {
    if (!AGREEMENT_ROLES.includes(link.role)) throw new PartyError(`unknown role: ${link.role}`);
    if (!this.parties.has(link.partyId)) throw new PartyError(`unknown party: ${link.partyId}`);
    if (link.sharePct !== undefined && (link.sharePct < 0 || link.sharePct > 100)) {
      throw new PartyError(`sharePct out of range (0..100): ${link.sharePct}`);
    }
    const dup = this.links.find(
      (l) => l.agreementId === link.agreementId && l.partyId === link.partyId && l.role === link.role && !l.to,
    );
    if (dup) throw new PartyError(`party ${link.partyId} is already ${link.role} on ${link.agreementId}`);
    this.links.push({ ...link });
    return { ...link };
  }

  /** End an open role link (e.g. a payer changes mid-lease). */
  release(agreementId: string, partyId: string, role: AgreementRole, at: string): void {
    const link = this.links.find(
      (l) => l.agreementId === agreementId && l.partyId === partyId && l.role === role && !l.to,
    );
    if (!link) throw new PartyError(`no open ${role} link for ${partyId} on ${agreementId}`);
    link.to = at;
  }

  partiesFor(agreementId: string, role?: AgreementRole): AgreementPartyRecord[] {
    return this.links
      .filter((l) => l.agreementId === agreementId && (role === undefined || l.role === role) && !l.to)
      .map((l) => ({ ...l }));
  }

  /**
   * Who receives and owes invoices: the financial_responsible if one is set,
   * otherwise the resident. This is how "parents pay for the student" works
   * without any special-casing at the billing layer.
   */
  billTo(agreementId: string): string | null {
    const fr = this.partiesFor(agreementId, 'financial_responsible')[0];
    if (fr) return fr.partyId;
    const res = this.partiesFor(agreementId, 'resident')[0];
    return res ? res.partyId : null;
  }

  allLinks(): readonly AgreementPartyRecord[] {
    return this.links.map((l) => ({ ...l }));
  }

  /**
   * Erase a party's PII in place (LGPD/GDPR right to be forgotten). Overwrites the
   * name/legalName/taxId/email/phone/attributes with a tombstone, keeping the opaque
   * id/tenant/kind that the immutable financial events reference. The role LINKS are
   * NOT removed — they are the financial record (who was responsible for which
   * money), retained by opaque party id. Returns the PII field names that were
   * cleared; throws if the party is unknown for the tenant.
   */
  erase(tenantId: string, id: string, redactor: (p: PartyRecord) => PartyRecord): string[] {
    const p = this.parties.get(id);
    if (!p || p.tenantId !== tenantId) throw new PartyError(`unknown party: ${id}`);
    const cleared: string[] = [];
    if (p.displayName) cleared.push('displayName');
    if (p.legalName) cleared.push('legalName');
    if (p.taxId) cleared.push('taxId');
    if (p.email) cleared.push('email');
    if (p.phone) cleared.push('phone');
    if (p.attributes && Object.keys(p.attributes).length > 0) cleared.push('attributes');
    this.parties.set(id, redactor(p));
    return cleared;
  }
}
