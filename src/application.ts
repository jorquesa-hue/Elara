// Rental applications — the leasing step between "toured" and "approved" that
// the funnel jumped over. An application captures the applicant, links a lead
// and a unit, carries a SCREENING result (credit/background/income — ordered
// through the connector framework, never scored here), and ends in an approve
// or deny DECISION. The decision is FCRA / Fair-Housing sensitive, so the App
// policy-gates + audits it and a denial requires an adverse-action reason (the
// letter goes out via the notification outbox). A PURE, zero-dep state machine.

export type ApplicationStatus = 'submitted' | 'screening' | 'approved' | 'denied' | 'withdrawn';

export interface ScreeningResult {
  provider?: string;
  reference?: string; // the vendor's report id
  recommendation?: 'approve' | 'review' | 'decline';
  creditScore?: number;
  completedAt?: string;
}

export interface Application {
  id: string;
  tenantId: string;
  leadId?: string;
  unitId?: string;
  applicantName: string;
  applicantEmail?: string;
  incomeCents?: number; // stated monthly income
  status: ApplicationStatus;
  submittedAt: string;
  screening?: ScreeningResult;
  decidedAt?: string;
  decidedBy?: string;
  /** Required on a denial — the reason communicated in the adverse-action letter. */
  adverseActionReason?: string;
}

export class ApplicationError extends Error {}

export class Applications {
  private apps = new Map<string, Application>();

  hydrate(records: readonly Application[]): void {
    for (const r of records) this.apps.set(r.id, { ...r, screening: r.screening ? { ...r.screening } : undefined });
  }

  submit(input: { id: string; tenantId: string; applicantName: string; applicantEmail?: string; leadId?: string; unitId?: string; incomeCents?: number; submittedAt: string }): Application {
    if (this.apps.has(input.id)) throw new ApplicationError(`duplicate application: ${input.id}`);
    if (!input.applicantName) throw new ApplicationError(`application ${input.id}: applicantName is required`);
    if (input.incomeCents !== undefined && (!Number.isInteger(input.incomeCents) || input.incomeCents < 0)) {
      throw new ApplicationError(`application ${input.id}: incomeCents must be a non-negative integer`);
    }
    const app: Application = {
      id: input.id,
      tenantId: input.tenantId,
      applicantName: input.applicantName,
      status: 'submitted',
      submittedAt: input.submittedAt,
      ...(input.applicantEmail ? { applicantEmail: input.applicantEmail } : {}),
      ...(input.leadId ? { leadId: input.leadId } : {}),
      ...(input.unitId ? { unitId: input.unitId } : {}),
      ...(input.incomeCents !== undefined ? { incomeCents: input.incomeCents } : {}),
    };
    this.apps.set(app.id, app);
    return this.get(app.id);
  }

  get(id: string): Application {
    const a = this.apps.get(id);
    if (!a) throw new ApplicationError(`unknown application: ${id}`);
    return { ...a, screening: a.screening ? { ...a.screening } : undefined };
  }

  /** Mark screening in progress (a screening command was enqueued to a vendor). */
  markScreening(id: string): Application {
    const a = this.mutable(id);
    if (a.status !== 'submitted' && a.status !== 'screening') throw new ApplicationError(`application ${id} is ${a.status}; cannot screen`);
    a.status = 'screening';
    return this.get(id);
  }

  /** Record a screening result (from the vendor's inbound event / manual entry). */
  recordScreening(id: string, result: ScreeningResult): Application {
    const a = this.mutable(id);
    if (a.status === 'approved' || a.status === 'denied' || a.status === 'withdrawn') throw new ApplicationError(`application ${id} is ${a.status}`);
    a.screening = { ...result };
    a.status = 'screening';
    return this.get(id);
  }

  approve(id: string, at: string, by: string): Application {
    const a = this.mutable(id);
    this.assertDecidable(a);
    a.status = 'approved';
    a.decidedAt = at;
    a.decidedBy = by;
    return this.get(id);
  }

  deny(id: string, at: string, by: string, reason: string): Application {
    const a = this.mutable(id);
    this.assertDecidable(a);
    if (!reason) throw new ApplicationError(`application ${id}: an adverse-action reason is required to deny`);
    a.status = 'denied';
    a.decidedAt = at;
    a.decidedBy = by;
    a.adverseActionReason = reason;
    return this.get(id);
  }

  withdraw(id: string, at: string): Application {
    const a = this.mutable(id);
    if (a.status === 'approved' || a.status === 'denied') throw new ApplicationError(`application ${id} is ${a.status}`);
    a.status = 'withdrawn';
    a.decidedAt = at;
    return this.get(id);
  }

  list(tenantId: string): Application[] {
    return [...this.apps.values()].filter((a) => a.tenantId === tenantId).map((a) => ({ ...a, screening: a.screening ? { ...a.screening } : undefined }));
  }

  private assertDecidable(a: Application): void {
    if (a.status === 'approved' || a.status === 'denied' || a.status === 'withdrawn') throw new ApplicationError(`application ${a.id} is already ${a.status}`);
  }

  private mutable(id: string): Application {
    const a = this.apps.get(id);
    if (!a) throw new ApplicationError(`unknown application: ${id}`);
    return a;
  }
}
