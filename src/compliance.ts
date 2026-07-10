// Compliance — data-subject rights (LGPD art. 18 / GDPR art. 15 & 17) reconciled
// with the event-sourced ledger. Two operations, both PURE + zero-dep here (the
// App supplies the data slices and applies the redaction to its stores):
//
//  • SUBJECT ACCESS (right of access) — assemble everything Elara holds about a
//    party into one export.
//  • ERASURE (right to be forgotten) — redact the party's PII, BUT NEVER touch the
//    append-only financial record. Invariant 1 forbids destructive writes to
//    agreement_event / journal_line / action_log, and financial-record retention
//    law overrides erasure for those anyway. The reconciliation is PSEUDONYMISATION:
//    the immutable events reference the party by OPAQUE id, so wiping the party's
//    name/email/phone/taxId de-identifies them while the money history stays intact
//    and balanced. The party id is retained as a non-identifying key.

import type { PartyRecord, AgreementPartyRecord } from './party.ts';

/** The tombstone left in a redacted party's display name. */
export const ERASURE_TOMBSTONE = '[erased]';

/** Marks a party as erased and strips every PII field, keeping only the opaque id,
 *  tenant, and kind (which the retained financial events still reference). The
 *  erasure marker lives in `attributes` (a jsonb column) so NO schema change is
 *  needed and it round-trips through the existing party projection. */
export function redactPartyRecord(p: PartyRecord, at: string, reason?: string): PartyRecord {
  return {
    id: p.id,
    tenantId: p.tenantId,
    kind: p.kind,
    displayName: ERASURE_TOMBSTONE,
    // legalName / taxId / email / phone are dropped entirely.
    attributes: { erased: true, erasedAt: at, ...(reason ? { reason } : {}) },
  };
}

export function isErased(p: PartyRecord | null | undefined): boolean {
  return !!(p && p.attributes && (p.attributes as Record<string, unknown>).erased === true);
}

/** A notification's PII is its recipient address; erasure redacts it (the kind and
 *  financial data keys are retained as a non-identifying delivery record). */
export function redactRecipient(): string {
  return ERASURE_TOMBSTONE;
}

// --- subject access export --------------------------------------------------

export interface SubjectAccessReport {
  generatedAt: string;
  party: PartyRecord;
  /** Role links to agreements (resident/guarantor/payee/…). */
  roles: AgreementPartyRecord[];
  /** Invoices addressed to this party (financial records — retained, disclosed). */
  invoices: Array<{ id: string; agreementId: string; totalCents: number; status: string; issuedAt: string }>;
  /** Accounts-payable bills where this party is the payee. */
  bills: Array<{ id: string; totalCents: number; status: string; issuedAt: string }>;
  /** Notifications sent to this party. */
  notifications: Array<{ id: string; channel: string; kind: string; status: string; createdAt: string }>;
  /** CRM leads / roommate prospects referencing this party. */
  leads: Array<{ id: string; stage: string }>;
  prospects: Array<{ id: string; name: string }>;
  /** True once the party has been erased (the report then carries only tombstones). */
  erased: boolean;
}

/** Assemble a subject-access export from already-scoped slices. Pure: the App
 *  gathers the tenant/party-scoped data and hands it in, so this stays testable
 *  and free of store coupling. */
export function buildSubjectAccessReport(input: {
  generatedAt: string;
  party: PartyRecord;
  roles: readonly AgreementPartyRecord[];
  invoices: readonly SubjectAccessReport['invoices'][number][];
  bills: readonly SubjectAccessReport['bills'][number][];
  notifications: readonly SubjectAccessReport['notifications'][number][];
  leads: readonly SubjectAccessReport['leads'][number][];
  prospects: readonly SubjectAccessReport['prospects'][number][];
}): SubjectAccessReport {
  return {
    generatedAt: input.generatedAt,
    party: { ...input.party },
    roles: input.roles.map((r) => ({ ...r })),
    invoices: input.invoices.map((i) => ({ ...i })),
    bills: input.bills.map((b) => ({ ...b })),
    notifications: input.notifications.map((n) => ({ ...n })),
    leads: input.leads.map((l) => ({ ...l })),
    prospects: input.prospects.map((p) => ({ ...p })),
    erased: isErased(input.party),
  };
}

/** What an erasure did — returned to the caller and recorded in the audit log. */
export interface ErasureReceipt {
  partyId: string;
  erasedAt: string;
  /** PII fields cleared on the party record. */
  redactedFields: string[];
  /** Count of notifications whose recipient address was redacted. */
  notificationsRedacted: number;
  /** The financial artifacts deliberately RETAINED (by opaque id) for legal record. */
  retained: { agreementRoles: number; invoices: number; bills: number };
}
