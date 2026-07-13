// Lease-document generation — the leasing step between an approved application
// and an e-signature. Once a resident is approved, the lease agreement itself
// has to be drafted from the deal terms (parties, unit, rent, term, deposit)
// before it can go out for signature. This module is the PURE, zero-dep
// generator: buildLeaseDocument(terms) assembles a titled, clause-structured
// lease that is JURISDICTION-AWARE (a BR lease cites the Lei do Inquilinato and
// contemplates a fiador; a US lease carries the Fair-Housing + security-deposit
// language), and renderLeaseText() flattens it to signable plain text. The
// document is DETERMINISTIC from the terms, so it needs no storage of its own —
// the App regenerates it on demand and feeds the title into an e-sign envelope
// (src/esign.ts), whose roster is drawn from the same parties. Signing the
// envelope does NOT execute the lease — lease.execute stays human-gated.

export interface LeaseParty {
  role: string; // landlord, resident, guarantor, cosigner…
  name: string;
}

export interface LeaseTerms {
  agreementId: string;
  landlordName: string;
  residentName: string;
  guarantorName?: string;
  cosignerName?: string;
  unitLabel: string;
  propertyName?: string;
  kind: string; // nightly | monthly | lease
  rateCents: number;
  currency: string; // ISO 4217
  start: string; // ISO date
  end: string; // ISO date
  depositCents?: number;
  jurisdiction: string; // BR, US, EU, PT, ES, MX, GB…
  taxIdLabel?: string; // CPF/CNPJ, EIN/SSN…
  generatedAt: string;
}

export interface LeaseClause {
  heading: string;
  body: string;
}

export interface LeaseDocument {
  agreementId: string;
  title: string;
  parties: LeaseParty[];
  clauses: LeaseClause[];
  jurisdiction: string;
  generatedAt: string;
}

export class LeaseDocError extends Error {}

/** Minimal, dependency-free major-unit money formatter (2 decimals). Presentation
 *  only — the authoritative figure is always the integer cents in the terms. */
function money(cents: number, currency: string): string {
  const neg = cents < 0;
  const s = Math.abs(Math.round(cents)).toString().padStart(3, '0');
  const major = s.slice(0, -2);
  const minor = s.slice(-2);
  return `${neg ? '-' : ''}${currency} ${Number(major).toLocaleString('en-US')}.${minor}`;
}

/** The recurring-rent cadence word for the lease body. */
function cadence(kind: string): string {
  if (kind === 'nightly') return 'per night';
  if (kind === 'monthly') return 'per month';
  return 'per month'; // a lease bills monthly rent
}

/** Build a lease document from deal terms. Pure + deterministic. */
export function buildLeaseDocument(terms: LeaseTerms): LeaseDocument {
  if (!terms.residentName) throw new LeaseDocError('a resident name is required to draft a lease');
  if (!terms.landlordName) throw new LeaseDocError('a landlord name is required to draft a lease');
  if (!terms.unitLabel) throw new LeaseDocError('a unit is required to draft a lease');

  const jur = terms.jurisdiction.toUpperCase();
  const where = terms.propertyName ? `${terms.unitLabel} at ${terms.propertyName}` : terms.unitLabel;

  const parties: LeaseParty[] = [
    { role: 'landlord', name: terms.landlordName },
    { role: 'resident', name: terms.residentName },
  ];
  if (terms.guarantorName) parties.push({ role: 'guarantor', name: terms.guarantorName });
  if (terms.cosignerName) parties.push({ role: 'cosigner', name: terms.cosignerName });

  const clauses: LeaseClause[] = [];

  clauses.push({
    heading: '1. Parties',
    body:
      `This Lease Agreement is entered into between ${terms.landlordName} ("Landlord") and ` +
      `${terms.residentName} ("Resident")` +
      (terms.guarantorName ? `, with ${terms.guarantorName} as Guarantor` : '') +
      (terms.cosignerName ? `, and ${terms.cosignerName} as Co-signer` : '') +
      `.`,
  });

  clauses.push({
    heading: '2. Premises',
    body: `The Landlord leases to the Resident the residential premises identified as ${where}.`,
  });

  clauses.push({
    heading: '3. Term',
    body: `The lease term runs from ${terms.start} to ${terms.end}.`,
  });

  clauses.push({
    heading: '4. Rent',
    body:
      `The Resident shall pay rent of ${money(terms.rateCents, terms.currency)} ${cadence(terms.kind)}, ` +
      `due in advance on the first day of each rental period.`,
  });

  if (terms.depositCents && terms.depositCents > 0) {
    clauses.push({
      heading: '5. Security Deposit',
      body:
        `A security deposit of ${money(terms.depositCents, terms.currency)} is held against damages beyond ` +
        `ordinary wear and tear` +
        (jur === 'BR' || jur === 'EU' || jur === 'PT' || jur === 'ES'
          ? `, held in a segregated account and returned per applicable law after the move-out inspection.`
          : `, and returned within the statutory period after the move-out inspection, less lawful deductions.`),
    });
  }

  // Jurisdiction-specific statutory clause.
  if (jur === 'BR') {
    clauses.push({
      heading: `${terms.depositCents ? '6' : '5'}. Legislação Aplicável`,
      body:
        `This lease is governed by the Brazilian Tenancy Law (Lei do Inquilinato, Lei nº 8.245/1991). ` +
        `Where a guarantor (fiador) is named, the guarantee subsists until the keys are returned unless ` +
        `otherwise released in writing.` +
        (terms.taxIdLabel ? ` The parties are identified by their ${terms.taxIdLabel}.` : ''),
    });
  } else if (jur === 'US') {
    clauses.push({
      heading: `${terms.depositCents ? '6' : '5'}. Fair Housing & Governing Law`,
      body:
        `This lease is offered in compliance with the federal Fair Housing Act and applicable state and ` +
        `local landlord-tenant law, without discrimination on any protected basis. Security-deposit ` +
        `handling and return follow the governing state statute.`,
    });
  } else {
    clauses.push({
      heading: `${terms.depositCents ? '6' : '5'}. Governing Law`,
      body: `This lease is governed by the residential tenancy law applicable in the ${jur} jurisdiction.`,
    });
  }

  clauses.push({
    heading: `${clauses.length + 1}. Signatures`,
    body:
      `By signing below, each party acknowledges having read and agreed to the terms of this lease. ` +
      `Execution of this document does not by itself constitute the regulated act of lease execution, ` +
      `which the Landlord confirms separately.`,
  });

  return {
    agreementId: terms.agreementId,
    title: `Residential Lease — ${where}`,
    parties,
    clauses,
    jurisdiction: jur,
    generatedAt: terms.generatedAt,
  };
}

/** Flatten a lease document to signable plain text. */
export function renderLeaseText(doc: LeaseDocument): string {
  const lines: string[] = [doc.title, ''];
  for (const c of doc.clauses) {
    lines.push(c.heading, c.body, '');
  }
  lines.push('Parties:');
  for (const p of doc.parties) lines.push(`  - ${p.role}: ${p.name}  ______________________`);
  return lines.join('\n');
}
