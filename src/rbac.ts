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
  'esign.read',
  'esign.manage',
  // Recording a signer's COMPLETION is the provider's webhook, relayed by the
  // service role — deliberately NOT in OPS, so an operator/agent cannot forge a
  // signature. Only owner/service hold it (via '*').
  'esign.complete',
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
  'integration.read', 'connector.dispatch', 'revenue.read', 'procurement.read',
  'roommate.read', 'roommate.manage',
  'crm.read', 'crm.manage',
  'esign.read', 'esign.manage',
  'ledger.read', 'exception.read', 'subscription.read',
  'masterdata.read', 'config.read',
];

export const BUILTIN_ROLES: readonly RoleDef[] = [
  { id: 'owner', name: 'Owner', permissions: '*', builtin: true, description: 'Full control incl. roles, config, users.' },
  { id: 'service', name: 'Service account', permissions: '*', builtin: true, description: 'Trusted backend / integrations.' },
  {
    id: 'manager',
    name: 'Manager',
    permissions: [...OPS, 'deposit.refund', 'exception.approve', 'user.read', 'user.manage', 'role.read', 'masterdata.manage', 'persistence.run', 'space.manage', 'entity.manage', 'bill.pay', 'reconciliation.read', 'reconciliation.manage', 'integration.manage', 'revenue.manage', 'procurement.manage', 'agreement.execute'],
    builtin: true,
    description: 'Runs the property: all operations, approvals, staff and master data.',
  },
  // 'staff' is a back-compat alias for manager-level access.
  {
    id: 'staff',
    name: 'Staff',
    permissions: [...OPS, 'deposit.refund', 'exception.approve', 'user.read', 'masterdata.manage', 'space.manage', 'entity.manage', 'bill.pay', 'reconciliation.read', 'reconciliation.manage', 'integration.manage', 'revenue.manage', 'procurement.manage', 'agreement.execute'],
    builtin: true,
    description: 'Approvals and day-to-day management.',
  },
  { id: 'front_desk', name: 'Front desk', permissions: OPS, builtin: true, description: 'Bookings, billing, payments — no approvals.' },
  {
    id: 'accountant',
    name: 'Accountant',
    permissions: ['invoice.read', 'payment.record', 'deposit.read', 'deposit.refund', 'ledger.read', 'subscription.read', 'masterdata.read', 'config.read', 'party.read', 'entity.read', 'entity.manage', 'bill.read', 'bill.issue', 'bill.pay', 'reconciliation.read', 'reconciliation.manage', 'procurement.read', 'procurement.manage'],
    builtin: true,
    description: 'Finance: ledger, payments, deposit refunds, accounts payable, reporting.',
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
