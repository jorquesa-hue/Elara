// CRM & pipeline KPIs (#20). Leasing is a sales funnel: a lead arrives, tours a
// unit, applies, is approved, and signs — or is lost along the way. This module
// is a PURE, zero-dep pipeline tracker plus the KPI rollups a dashboard needs
// (funnel counts, open pipeline value, win rate). It is a CONFIG/reporting layer
// — advancing a lead to "signed" records the sales outcome; the actual lease
// execution still goes through the agreement + lease.execute policy path, so no
// money or regulated action happens here. External CRMs (#17 Salesforce/Zoho)
// feed leads in through the connector framework; this is the canonical funnel.

export type LeadStage = 'new' | 'toured' | 'applied' | 'approved' | 'signed' | 'lost';

// The forward funnel; 'signed' = won, 'lost' = terminal loss (off the ladder).
export const PIPELINE: readonly LeadStage[] = ['new', 'toured', 'applied', 'approved', 'signed'];
const OPEN_STAGES: ReadonlySet<LeadStage> = new Set(['new', 'toured', 'applied', 'approved']);

export interface Lead {
  id: string;
  tenantId: string;
  name: string;
  source?: string; // website, walk-in, Salesforce, referral…
  stage: LeadStage;
  estValueCents: number; // expected monthly/lease value — powers pipeline value
  partyId?: string; // optional link to a party once created
  createdAt: string;
  updatedAt: string;
  stageAt: Partial<Record<LeadStage, string>>; // when each stage was entered
  lostReason?: string;
}

export interface CrmKpis {
  total: number;
  byStage: Record<LeadStage, number>;
  openCount: number;
  wonCount: number;
  lostCount: number;
  pipelineValueCents: number; // sum est value of OPEN leads
  wonValueCents: number; // sum est value of signed leads
  conversionPct: number; // signed / (signed + lost), 0..100 one decimal
}

export class CrmError extends Error {}

/** Pure: fold a set of leads into the funnel KPIs. */
export function crmKpis(leads: readonly Lead[]): CrmKpis {
  const byStage: Record<LeadStage, number> = { new: 0, toured: 0, applied: 0, approved: 0, signed: 0, lost: 0 };
  let pipelineValueCents = 0;
  let wonValueCents = 0;
  for (const l of leads) {
    byStage[l.stage]++;
    if (OPEN_STAGES.has(l.stage)) pipelineValueCents += l.estValueCents;
    if (l.stage === 'signed') wonValueCents += l.estValueCents;
  }
  const wonCount = byStage.signed;
  const lostCount = byStage.lost;
  const openCount = leads.length - wonCount - lostCount;
  const closed = wonCount + lostCount;
  return {
    total: leads.length,
    byStage,
    openCount,
    wonCount,
    lostCount,
    pipelineValueCents,
    wonValueCents,
    conversionPct: closed > 0 ? Math.round((wonCount / closed) * 1000) / 10 : 0,
  };
}

export class Crm {
  private leads = new Map<string, Lead>();

  createLead(input: { id: string; tenantId: string; name: string; source?: string; estValueCents?: number; partyId?: string; createdAt: string }): Lead {
    if (this.leads.has(input.id)) throw new CrmError(`duplicate lead: ${input.id}`);
    if (!input.name) throw new CrmError(`lead ${input.id}: name is required`);
    const est = input.estValueCents ?? 0;
    if (!Number.isInteger(est) || est < 0) throw new CrmError(`lead ${input.id}: estValueCents must be a non-negative integer`);
    const lead: Lead = {
      id: input.id,
      tenantId: input.tenantId,
      name: input.name,
      source: input.source,
      stage: 'new',
      estValueCents: est,
      partyId: input.partyId,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      stageAt: { new: input.createdAt },
    };
    this.leads.set(lead.id, lead);
    return this.get(lead.id);
  }

  get(id: string): Lead {
    const l = this.leads.get(id);
    if (!l) throw new CrmError(`unknown lead: ${id}`);
    return { ...l, stageAt: { ...l.stageAt } };
  }

  /** Move a lead forward in the funnel. Only forward moves are allowed (a lead
   *  never un-signs); use lose() to drop it. */
  advance(id: string, to: LeadStage, at: string): Lead {
    const l = this.mutable(id);
    if (l.stage === 'signed' || l.stage === 'lost') throw new CrmError(`lead ${id} is ${l.stage}; it is closed`);
    const from = PIPELINE.indexOf(l.stage);
    const toIdx = PIPELINE.indexOf(to);
    if (toIdx < 0) throw new CrmError(`cannot advance to '${to}'`);
    if (toIdx <= from) throw new CrmError(`lead ${id} cannot move backward (${l.stage} → ${to})`);
    l.stage = to;
    l.stageAt[to] = at;
    l.updatedAt = at;
    return this.get(id);
  }

  lose(id: string, reason: string, at: string): Lead {
    const l = this.mutable(id);
    if (l.stage === 'signed' || l.stage === 'lost') throw new CrmError(`lead ${id} is ${l.stage}; it is closed`);
    l.stage = 'lost';
    l.lostReason = reason;
    l.stageAt.lost = at;
    l.updatedAt = at;
    return this.get(id);
  }

  list(tenantId: string): Lead[] {
    return [...this.leads.values()].filter((l) => l.tenantId === tenantId).map((l) => ({ ...l, stageAt: { ...l.stageAt } }));
  }

  kpis(tenantId: string): CrmKpis {
    return crmKpis(this.list(tenantId));
  }

  private mutable(id: string): Lead {
    const l = this.leads.get(id);
    if (!l) throw new CrmError(`unknown lead: ${id}`);
    return l;
  }
}
