// E-signature for lease execution (#17, the CRM → lease → e-sign tail). When a
// CRM lead is won, the lease document goes out for signature. This module is the
// PURE, zero-dep envelope state machine that tracks that flow — draft → sent →
// signed (or declined / voided) — with a signer roster and per-signer
// completion. The provider (DocuSign/Clicksign/…) is reached from an edge
// adapter that resolves a secretRef against the secret store, exactly like the
// connector framework; NO credential ever enters the kernel. Crucially, a fully
// signed envelope does NOT auto-execute the lease: lease.execute stays behind the
// PolicyEnvelope escalation (a regulated, irreversible action a human confirms).
// Signing here records the sales/document outcome and can advance the CRM lead;
// the binding lease execution remains a separate, human-gated step.

export type EnvelopeStatus = 'draft' | 'sent' | 'signed' | 'declined' | 'voided';

export interface Signer {
  name: string;
  email: string;
  role: string; // resident, guarantor, cosigner, operator…
  partyId?: string; // optional link to a party
  order?: number; // signing order (informational)
  signedAt?: string;
  declinedAt?: string;
}

export interface SignatureEnvelope {
  id: string;
  tenantId: string;
  documentName: string;
  provider: string; // docusign, clicksign, dropbox_sign…
  providerRef?: string; // the external envelope id (NON-secret)
  leadId?: string; // the CRM lead this closes
  agreementId?: string; // the lease this will bind, once executed
  signers: Signer[];
  status: EnvelopeStatus;
  createdAt: string;
  sentAt?: string;
  completedAt?: string;
  voidReason?: string;
  declineReason?: string;
}

export class EsignError extends Error {}

function normEmail(e: string): string {
  return e.trim().toLowerCase();
}

export class Signatures {
  private envelopes = new Map<string, SignatureEnvelope>();

  create(input: {
    id: string;
    tenantId: string;
    documentName: string;
    provider: string;
    leadId?: string;
    agreementId?: string;
    signers: Array<{ name: string; email: string; role: string; partyId?: string; order?: number }>;
    createdAt: string;
  }): SignatureEnvelope {
    if (this.envelopes.has(input.id)) throw new EsignError(`duplicate envelope: ${input.id}`);
    if (!input.documentName) throw new EsignError('documentName is required');
    if (!input.provider) throw new EsignError('provider is required');
    if (!input.signers.length) throw new EsignError('at least one signer is required');
    const emails = new Set<string>();
    for (const s of input.signers) {
      if (!s.name || !s.email) throw new EsignError('each signer needs a name and an email');
      const e = normEmail(s.email);
      if (emails.has(e)) throw new EsignError(`duplicate signer email: ${s.email}`);
      emails.add(e);
    }
    const env: SignatureEnvelope = {
      id: input.id,
      tenantId: input.tenantId,
      documentName: input.documentName,
      provider: input.provider,
      leadId: input.leadId,
      agreementId: input.agreementId,
      signers: input.signers.map((s) => ({ ...s })),
      status: 'draft',
      createdAt: input.createdAt,
    };
    this.envelopes.set(env.id, env);
    return this.get(env.id);
  }

  get(id: string): SignatureEnvelope {
    const e = this.envelopes.get(id);
    if (!e) throw new EsignError(`unknown envelope: ${id}`);
    return { ...e, signers: e.signers.map((s) => ({ ...s })) };
  }

  /** Dispatch the envelope to the provider (the edge adapter does the real I/O;
   *  we record it went out and stamp the external ref). */
  send(id: string, at: string, providerRef?: string): SignatureEnvelope {
    const e = this.mutable(id);
    if (e.status !== 'draft') throw new EsignError(`envelope ${id} is ${e.status}; only a draft can be sent`);
    e.status = 'sent';
    e.sentAt = at;
    if (providerRef) e.providerRef = providerRef;
    return this.get(id);
  }

  /** Record a signer's completion (the provider webhook, relayed by the edge
   *  adapter). When every signer has signed, the envelope is fully signed. */
  recordSigned(id: string, email: string, at: string): { envelope: SignatureEnvelope; completed: boolean } {
    const e = this.mutable(id);
    if (e.status !== 'sent') throw new EsignError(`envelope ${id} is ${e.status}; not out for signature`);
    const signer = e.signers.find((s) => normEmail(s.email) === normEmail(email));
    if (!signer) throw new EsignError(`no signer with email ${email} on envelope ${id}`);
    if (signer.declinedAt) throw new EsignError(`signer ${email} already declined`);
    signer.signedAt = at;
    const completed = e.signers.every((s) => s.signedAt);
    if (completed) { e.status = 'signed'; e.completedAt = at; }
    return { envelope: this.get(id), completed };
  }

  /** A signer refuses; the whole envelope is declined. */
  decline(id: string, email: string, reason: string, at: string): SignatureEnvelope {
    const e = this.mutable(id);
    if (e.status !== 'sent') throw new EsignError(`envelope ${id} is ${e.status}; not out for signature`);
    const signer = e.signers.find((s) => normEmail(s.email) === normEmail(email));
    if (!signer) throw new EsignError(`no signer with email ${email} on envelope ${id}`);
    signer.declinedAt = at;
    e.status = 'declined';
    e.declineReason = reason;
    return this.get(id);
  }

  void(id: string, reason: string, at: string): SignatureEnvelope {
    const e = this.mutable(id);
    if (e.status === 'signed' || e.status === 'voided') throw new EsignError(`envelope ${id} is ${e.status}; cannot void`);
    e.status = 'voided';
    e.voidReason = reason;
    return this.get(id);
  }

  list(tenantId: string): SignatureEnvelope[] {
    return [...this.envelopes.values()].filter((e) => e.tenantId === tenantId).map((e) => this.get(e.id));
  }

  private mutable(id: string): SignatureEnvelope {
    const e = this.envelopes.get(id);
    if (!e) throw new EsignError(`unknown envelope: ${id}`);
    return e;
  }
}
