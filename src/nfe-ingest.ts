// NF-e ingestion: parses a Brazilian Nota Fiscal eletrônica (supplier invoice)
// into accounts-payable. The kernel stays zero-dependency (invariant 7), so
// parsing is a small hand-rolled reader over the well-known NF-e element set —
// no XML library. Only the fields the ledger needs are extracted.

import { Ledger } from './ledger.ts';
import { ACCOUNTS } from './billing.ts';

export interface NfeDocument {
  chaveAcesso: string; // 44-digit access key, unique per NF-e
  emitCnpj: string;
  emitName: string;
  totalCents: number;
  currency: string;
  issuedAt: string;
}

export class NfeError extends Error {}

function extractTag(xml: string, tag: string): string | undefined {
  // Matches <tag>value</tag> or <ns:tag>value</ns:tag>, first occurrence.
  const re = new RegExp(`<(?:[A-Za-z0-9]+:)?${tag}>([^<]*)</(?:[A-Za-z0-9]+:)?${tag}>`);
  const m = re.exec(xml);
  return m ? m[1] : undefined;
}

function extractAttr(xml: string, tag: string, attr: string): string | undefined {
  const re = new RegExp(`<(?:[A-Za-z0-9]+:)?${tag}\\b[^>]*\\b${attr}="([^"]*)"`);
  const m = re.exec(xml);
  return m ? m[1] : undefined;
}

export function parseNfe(xml: string): NfeDocument {
  // Access key lives in the Id attribute of <infNFe Id="NFe4431...">.
  const rawId = extractAttr(xml, 'infNFe', 'Id') ?? '';
  const chaveAcesso = rawId.replace(/^NFe/, '');
  if (!/^\d{44}$/.test(chaveAcesso)) {
    throw new NfeError('NF-e missing or malformed 44-digit access key (infNFe/@Id)');
  }
  const emitCnpj = extractTag(xml, 'CNPJ');
  const emitName = extractTag(xml, 'xNome');
  const vnf = extractTag(xml, 'vNF');
  const dhEmi = extractTag(xml, 'dhEmi') ?? extractTag(xml, 'dEmi');
  if (!emitCnpj) throw new NfeError('NF-e missing emitter CNPJ');
  if (!vnf) throw new NfeError('NF-e missing total value (vNF)');
  if (!dhEmi) throw new NfeError('NF-e missing issue date (dhEmi)');

  const totalCents = Math.round(parseFloat(vnf) * 100);
  if (!Number.isFinite(totalCents) || totalCents <= 0) {
    throw new NfeError(`NF-e total is not a positive amount: ${vnf}`);
  }

  return {
    chaveAcesso,
    emitCnpj,
    emitName: emitName ?? 'unknown',
    totalCents,
    currency: 'BRL',
    issuedAt: dhEmi,
  };
}

export class NfeInbox {
  private seen = new Map<string, NfeDocument>();

  constructor(private readonly ledger: Ledger) {}

  /** Parse + book supplier expense against accounts payable. Idempotent by key. */
  ingest(xml: string): NfeDocument {
    const doc = parseNfe(xml);
    if (this.seen.has(doc.chaveAcesso)) {
      throw new NfeError(`NF-e ${doc.chaveAcesso} already ingested`);
    }
    this.ledger.post({
      entryId: `je-nfe-${doc.chaveAcesso}`,
      postedAt: doc.issuedAt,
      currency: doc.currency,
      memo: `NF-e ${doc.chaveAcesso} from ${doc.emitName}`,
      lines: [
        { account: ACCOUNTS.supplierExpense, debitCents: doc.totalCents },
        { account: ACCOUNTS.accountsPayable, creditCents: doc.totalCents },
      ],
    });
    this.seen.set(doc.chaveAcesso, doc);
    return { ...doc };
  }

  ingested(): readonly NfeDocument[] {
    return [...this.seen.values()].map((d) => ({ ...d }));
  }
}
