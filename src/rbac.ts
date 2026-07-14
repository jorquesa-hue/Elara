// Access profiling. Permissions are granular `resource.action` strings; roles
// bundle permissions; users hold a role. Built-in roles cover the common
// hospitality org chart, and tenants may DEFINE CUSTOM ROLES — so the model is
// well-defined yet flexible enough for any business structure (a family-run
// short-let with two roles, or a multifamily operator with a deep hierarchy).
//
// This is the authorization layer the Public API enforces per endpoint, on top
// of the PolicyEnvelope (which gates irreversible/regulated ACTIONS regardless
// of who is asking). Two orthogonal gates: RBAC answers "may this user do this
// at all?", the policy envelope answers "is this action safe to auto-execute?".

export const PERMISSIONS = [
  'agreement.read',
  'agreement.book',
  'agreement.activate',
  'agreement.convert',
  'invoice.read',
  'invoice.issue',
  'payment.record',
  'deposit.read',
  'deposit.hold',
  'deposit.refund',
  'ledger.read',
  'exception.read',
  'exception.approve',
  'subscription.read',
  'config.read',
  'config.manage',
  'user.read',
  'user.manage',
  'role.read',
  'role.manage',
  'masterdata.read',
  'masterdata.manage',
  'persistence.run',
  'agreement.adjust',
  'agreement.transfer',
  // Initiating a lease execution. The policy envelope ESCALATES lease.execute in
  // every jurisdiction, so this permission only gates who may REQUEST it — the
  // binding still needs a human to approve the escalation. Deliberately NOT in OPS
  // (agents can't initiate a regulated binding).
  'agreement.execute',
  'party.read',
  'party.manage',
  'space.read',
  'space.manage',
  'entity.read',
  'entity.manage',
  'bill.read',
  'bill.issue',
  'bill.pay',
  'maintenance.read',
  'maintenance.manage',
  'reservation.read',
  'reservation.manage',
  'agreement.move',
  'inspection.read',
  'inspection.manage',
  'comms.read',
  'comms.send',
  'comms.manage',
  'reconciliation.read',
  'reconciliation.manage',
  'integration.read',
  'integration.manage',
  'connector.dispatch',
  'revenue.read',
  'revenue.manage',
  'procurement.read',
  'procurement.manage',
  'roommate.read',
  'roommate.manage',
  'crm.read',
  'crm.manage',
  // Rental applications + the approve/deny decision. The decision is FCRA /
  // Fair-Housing sensitive, so it is additionally policy-gated + audited.
  'application.read',
  'application.manage',
  // Tour scheduling — the top of the leasing funnel (a prospect walking a unit).
  'tour.read',
  'tour.manage',
  // Unit turns (make-ready) — the operations board tracking a vacant unit to
  // rent-ready. Operational, RBAC-only (no money movement).
  'turn.read',
  'turn.manage',
  // Renters-insurance compliance — tracking each lease's liability coverage and
  // flagging lapses/expirations. A liability-tracking record, not a money move,
  // so RBAC-only (no PolicyEnvelope action). Managing is in OPS (leasing/front-
  // desk collect certificates); reading is broadly available via READS.
  'insurance.read',
  'insurance.manage',
  // Utility billing / RUBS — recovering a master utility bill from residents by
  // an allocation ratio. Reading is broadly available (OPS + READS); managing
  // (creating a bill + raising the resident invoices) is a FINANCE function
  // (manager/staff/accountant/owner), NOT in the generic OPS bundle. The invoices
  // it raises still pass the invoice.issue policy gate — no bypass.
  'utility.read',
  'utility.manage',
  // Package / parcel room — logging resident deliveries, notifying recipients,
  // recording pickup. A front-desk task, so both are in OPS. RBAC-only (the
  // arrival notification rides the existing outbox; no PolicyEnvelope action).
  'package.read',
  'package.manage',
  // Prospect waitlist — a leasing-funnel tool (a queue for a floorplan when it's
  // full). Both in OPS (leasing agents run the waitlist); converting a prospect
  // creates a CRM lead through the existing gated path. RBAC-only.
  'waitlist.read',
  'waitlist.manage',
  // Owner distributions — returning operating cash to an owning legal entity (an
  // equity draw). Reading is broadly available (OPS + READS); RECORDING moves
  // money out, so it's a FINANCE function (manager/staff/accountant/owner), NOT
  // in OPS, and the amount is additionally policy-gated (large -> escalate).
  'distribution.read',
  'distribution.record',
  'esign.read',
  'esign.manage',
  // Recording a signer's COMPLETION is the provider's webhook, relayed by the
  // service role — deliberately NOT in OPS, so an operator/agent cannot forge a
  // signature. Only owner/service hold it (via '*').
  'esign.complete',
  // Running the overdue-collections sweep (usually a scheduled service-role cron,
  // or a manager on demand). Each stage action it takes is still policy-gated.
  'collections.run',
  // Lease renewals: reading the due-offer list (in OPS/READS) and running the
  // renewal sweep (a scheduled service-role cron, or a manager on demand).
  // Applying a renewal reuses agreement.adjust — it is a rent + term change.
  'renewal.read',
  'renewal.run',
  // Closing / re-opening accounting periods (month-end). Finance function;
  // re-opening a closed period is additionally policy-gated (escalate).
  'period.manage',
  // Receiving a vendor-initiated integration event (the inbound webhook, relayed by
  // the service role) — deliberately NOT in OPS, like esign.complete.
  'integration.events',
  // Enqueuing an outbound notification (email/SMS) + reading the outbox. Sending is
  // routine (front-of-house), so send is in OPS; the actual delivery is an edge worker.
  'notification.read',
  'notification.send',
  // Scraping the process-wide operational metrics (GET /metrics). Aggregate counts,
  // not tenant records — held by owner/service/manager, deliberately NOT a `.read`
  // (so it isn't auto-granted to the generic read_only bundle) and NOT in OPS.
  'metrics.scrape',
  // Data-subject rights (LGPD/GDPR), a DPO function. `privacy.export` produces a
  // subject-access report (PII) — deliberately NOT a `.read` so read_only doesn't
  // inherit bulk PII export; `privacy.manage` performs an irreversible erasure.
  // Both held by owner/service/manager, NOT in OPS (front-desk/agent can't erase).
  'privacy.export',
  'privacy.manage',
  // Self-service reporting + automated insights. Aggregate operational/financial
  // views over the tenant's own data — broadly readable (in OPS + READS, so
  // read_only and front-of-house can pull reports).
  'reports.read',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ALL = new Set<Permission>(PERMISSIONS);
const READS = PERMISSIONS.filter((p) => p.endsWith('.read'));

export interface RoleDef {
  id: string;
  name: string;
  /** '*' means every permission (owner/service). */
  permissions: readonly Permission[] | '*';
  builtin: boolean;
  description?: string;
}

// Operational bundle shared by front-of-house/agent roles.
const OPS: Permission[] = [
  'agreement.read', 'agreement.book', 'agreement.activate', 'agreement.convert',
  'agreement.adjust', 'agreement.transfer', 'agreement.move',
  'inspection.read', 'inspection.manage',
  'invoice.read', 'invoice.issue', 'payment.record',
  'deposit.read', 'deposit.hold',
  'party.read', 'party.manage', 'space.read', 'entity.read', 'bill.read', 'bill.issue',
  'maintenance.read', 'maintenance.manage', 'reservation.read', 'reservation.manage',
  'comms.read', 'comms.send', 'comms.manage',
  'notification.read', 'notification.send',
  'integration.read', 'connector.dispatch', 'revenue.read', 'procurement.read',
  'roommate.read', 'roommate.manage',
  'crm.read', 'crm.manage',
  'application.read', 'application.manage',
  'tour.read', 'tour.manage',
  'turn.read', 'turn.manage',
  'insurance.read', 'insurance.manage',
  'utility.read',
  'package.read', 'package.manage',
  'waitlist.read', 'waitlist.manage',
  'distribution.read',
  'esign.read', 'esign.manage',
  'renewal.read',
  'ledger.read', 'exception.read', 'subscription.read',
  'masterdata.read', 'config.read', 'reports.read',
];

export const BUILTIN_ROLES: readonly RoleDef[] = [
  { id: 'owner', name: 'Owner', permissions: '*', builtin: true, description: 'Full control incl. roles, config, users.' },
  { id: 'service', name: 'Service account', permissions: '*', builtin: true, description: 'Trusted backend / integrations.' },
  {
    id: 'manager',
    name: 'Manager',
    permissions: [...OPS, 'deposit.refund', 'exception.approve', 'user.read', 'user.manage', 'role.read', 'masterdata.manage', 'persistence.run', 'space.manage', 'entity.manage', 'bill.pay', 'reconciliation.read', 'reconciliation.manage', 'integration.manage', 'revenue.manage', 'procurement.manage', 'utility.manage', 'distribution.record', 'agreement.execute', 'collections.run', 'renewal.run', 'period.manage', 'metrics.scrape', 'privacy.export', 'privacy.manage'],
    builtin: true,
    description: 'Runs the property: all operations, approvals, staff and master data.',
  },
  // 'staff' is a back-compat alias for manager-level access.
  {
    id: 'staff',
    name: 'Staff',
    permissions: [...OPS, 'deposit.refund', 'exception.approve', 'user.read', 'masterdata.manage', 'space.manage', 'entity.manage', 'bill.pay', 'reconciliation.read', 'reconciliation.manage', 'integration.manage', 'revenue.manage', 'procurement.manage', 'utility.manage', 'distribution.record', 'agreement.execute', 'collections.run', 'renewal.run', 'period.manage', 'metrics.scrape', 'privacy.export', 'privacy.manage'],
    builtin: true,
    description: 'Approvals and day-to-day management.',
  },
  { id: 'front_desk', name: 'Front desk', permissions: OPS, builtin: true, description: 'Bookings, billing, payments — no approvals.' },
  {
    id: 'accountant',
    name: 'Accountant',
    permissions: ['invoice.read', 'invoice.issue', 'payment.record', 'deposit.read', 'deposit.refund', 'ledger.read', 'reports.read', 'collections.run', 'period.manage', 'subscription.read', 'masterdata.read', 'config.read', 'party.read', 'entity.read', 'entity.manage', 'bill.read', 'bill.issue', 'bill.pay', 'reconciliation.read', 'reconciliation.manage', 'procurement.read', 'procurement.manage', 'utility.read', 'utility.manage', 'distribution.read', 'distribution.record'],
    builtin: true,
    description: 'Finance: bills rent, ledger, payments, deposit refunds, accounts payable, collections, reporting.',
  },
  {
    id: 'agent',
    name: 'AI agent',
    permissions: OPS, // operational, but crucially NO exception.approve
    builtin: true,
    description: 'Autonomous concierge/ops agent. Cannot approve escalations.',
  },
  { id: 'read_only', name: 'Read only', permissions: READS, builtin: true, description: 'View everything, change nothing.' },
  { id: 'guest', name: 'Guest', permissions: ['agreement.read', 'invoice.read'], builtin: true, description: 'A guest viewing their own stay.' },
] as const;

export class RbacError extends Error {}

export class RoleRegistry {
  private custom = new Map<string, RoleDef>(); // key: `${tenantId}:${roleId}`
  private readonly builtins = new Map<string, RoleDef>();

  constructor() {
    for (const r of BUILTIN_ROLES) this.builtins.set(r.id, r);
  }

  /** Define or replace a tenant-scoped custom role. Built-in ids are reserved. */
  defineRole(tenantId: string, role: { id: string; name: string; permissions: Permission[]; description?: string }): RoleDef {
    if (this.builtins.has(role.id)) throw new RbacError(`'${role.id}' is a built-in role and cannot be redefined`);
    for (const p of role.permissions) {
      if (!ALL.has(p)) throw new RbacError(`unknown permission: ${p}`);
    }
    const def: RoleDef = { ...role, builtin: false };
    this.custom.set(`${tenantId}:${role.id}`, def);
    return def;
  }

  resolve(tenantId: string, roleId: string): RoleDef | null {
    return this.custom.get(`${tenantId}:${roleId}`) ?? this.builtins.get(roleId) ?? null;
  }

  /** The effective permission set for a role, built-ins + tenant custom. */
  permissionsFor(tenantId: string, roleId: string): Set<Permission> {
    const def = this.resolve(tenantId, roleId);
    if (!def) return new Set();
    if (def.permissions === '*') return new Set(ALL);
    return new Set(def.permissions);
  }

  /** Roles available to a tenant: all built-ins plus its custom roles. */
  listRoles(tenantId: string): RoleDef[] {
    const out = [...this.builtins.values()];
    for (const [key, def] of this.custom) {
      if (key.startsWith(`${tenantId}:`)) out.push(def);
    }
    return out;
  }

  /** Only a tenant's CUSTOM roles — the persistable, non-built-in ones. */
  customRolesFor(tenantId: string): RoleDef[] {
    const out: RoleDef[] = [];
    for (const [key, def] of this.custom) {
      if (key.startsWith(`${tenantId}:`)) out.push(def);
    }
    return out;
  }
}

export function can(perms: ReadonlySet<Permission>, permission: Permission): boolean {
  return perms.has(permission);
}
