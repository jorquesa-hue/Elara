// Access Advisor — turns a plain-language description of what a person does into a
// concrete, least-privilege access recommendation: the capabilities they need, the
// exact permissions those imply, the closest built-in role (or a proposed custom
// role), a human rationale, and RISK FLAGS for sensitive grants (refunds, payouts,
// approvals, user administration, data erasure). Pure, deterministic, zero-dep and
// explainable — the "AI" is a transparent capability model an operator can trust
// and an LLM can later re-rank or narrate on top of (the description is the seam).

import { PERMISSIONS, BUILTIN_ROLES, type Permission, type RoleDef } from './rbac.ts';

const ALL_PERMS = new Set<string>(PERMISSIONS);
const p = (perm: string): Permission => perm as Permission;

/** A named cluster of permissions a role might need, with the phrases that imply it. */
export interface Capability {
  key: string;
  label: string;
  /** Lowercase trigger phrases matched (as word-ish substrings) against the description. */
  keywords: readonly string[];
  permissions: readonly Permission[];
  /** A grant that hands out money-moving, irreversible, or administrative power. */
  sensitive?: boolean;
  /** One line explaining what this capability lets the person do. */
  note: string;
}

/** The capability model. Permissions reference real RBAC permissions; anything not
 *  in the live permission set is filtered out, so this can't drift into invalid grants. */
export const CAPABILITIES: readonly Capability[] = [
  {
    key: 'view', label: 'View & dashboards', note: 'Read-only visibility across the portfolio.',
    keywords: ['view', 'read only', 'read-only', 'readonly', 'see', 'look', 'monitor', 'oversight', 'dashboard', 'observe', 'audit'],
    permissions: [p('agreement.read'), p('invoice.read'), p('ledger.read'), p('reports.read'), p('masterdata.read'), p('config.read')],
  },
  {
    key: 'front_desk', label: 'Front desk & bookings', note: 'Take bookings, check guests in/out, raise invoices.',
    keywords: ['front desk', 'reception', 'receptionist', 'check in', 'check-in', 'checkin', 'checkout', 'check out', 'book', 'booking', 'reservation', 'arrival', 'concierge', 'guest services', 'stays'],
    permissions: [p('agreement.read'), p('agreement.book'), p('agreement.activate'), p('agreement.move'), p('reservation.read'), p('reservation.manage'), p('invoice.read'), p('invoice.issue'), p('party.read'), p('party.manage')],
  },
  {
    key: 'payments', label: 'Payments & deposits', note: 'Record payments and take security deposits.',
    keywords: ['payment', 'take payment', 'collect', 'receipt', 'deposit', 'charge card', 'settle', 'cashier'],
    permissions: [p('invoice.read'), p('invoice.issue'), p('payment.record'), p('deposit.read'), p('deposit.hold')],
  },
  {
    key: 'refunds', label: 'Refunds & deposit returns', note: 'Return deposits and issue refunds.', sensitive: true,
    keywords: ['refund', 'deposit refund', 'return deposit', 'money back', 'reimburse', 'chargeback'],
    permissions: [p('deposit.read'), p('deposit.refund')],
  },
  {
    key: 'accounting', label: 'Accounting & payables', note: 'Ledger, bills, vendor payouts, bank reconciliation.', sensitive: true,
    keywords: ['account', 'accountant', 'bookkeep', 'ledger', 'finance', 'financial', 'payable', 'accounts payable', ' ap ', 'vendor', 'pay vendor', 'reconcile', 'reconciliation', 'bank', 'controller', 'cfo'],
    permissions: [p('ledger.read'), p('invoice.read'), p('payment.record'), p('bill.read'), p('bill.issue'), p('bill.pay'), p('reconciliation.read'), p('reconciliation.manage'), p('procurement.read'), p('procurement.manage'), p('deposit.read'), p('deposit.refund')],
  },
  {
    key: 'maintenance', label: 'Maintenance & housekeeping', note: 'Raise and run work orders.',
    keywords: ['maintenance', 'repair', 'work order', 'fix', 'handyman', 'housekeep', 'clean', 'facilit', 'janitor', 'technician', 'upkeep'],
    permissions: [p('maintenance.read'), p('maintenance.manage'), p('space.read'), p('reservation.read')],
  },
  {
    key: 'sales', label: 'Sales, leasing & e-sign', note: 'Work the CRM pipeline and send documents for signature.',
    keywords: ['sales', 'sell', 'lead', 'crm', 'pipeline', 'leasing', 'leasing agent', 'sign', 'e-sign', 'esign', 'signature', 'tour', 'showing', 'prospect', 'convert'],
    permissions: [p('crm.read'), p('crm.manage'), p('esign.read'), p('esign.manage'), p('agreement.read'), p('party.read')],
  },
  {
    key: 'pricing', label: 'Pricing & revenue', note: 'Set rate plans and manage dynamic pricing.',
    keywords: ['pricing', 'price', 'rate', 'rates', 'revenue manag', 'yield', 'adr', 'revpar', 'occupancy strategy'],
    permissions: [p('revenue.read'), p('revenue.manage')],
  },
  {
    key: 'setup', label: 'Property & master-data setup', note: 'Create units, spaces, charge types and import portfolios.',
    keywords: ['unit', 'property', 'master data', 'setup', 'set up', 'onboard', 'import', 'space', 'room', 'inventory', 'legal entity', 'charge type', 'catalog'],
    permissions: [p('masterdata.read'), p('masterdata.manage'), p('space.read'), p('space.manage'), p('entity.read'), p('entity.manage'), p('party.read'), p('party.manage')],
  },
  {
    key: 'comms', label: 'Guest communications', note: 'Message guests and send notifications.',
    keywords: ['message', 'communicat', 'inbox', 'contact', 'notif', 'email', 'sms', 'reminder', 'support', 'respond', 'reply'],
    permissions: [p('comms.read'), p('comms.send'), p('comms.manage'), p('notification.read'), p('notification.send')],
  },
  {
    key: 'reporting', label: 'Reporting & insights', note: 'Pull self-service reports and analytics.',
    keywords: ['report', 'reporting', 'insight', 'analytics', 'analyst', 'kpi', 'metric', 'export', 'bi', 'business intelligence'],
    permissions: [p('reports.read'), p('ledger.read'), p('revenue.read'), p('crm.read')],
  },
  {
    key: 'collections', label: 'Collections', note: 'Run the overdue-collections ladder.',
    keywords: ['collection', 'overdue', 'dunning', 'chase payment', 'past due', 'arrears', 'late payment'],
    permissions: [p('collections.run'), p('invoice.read'), p('ledger.read')],
  },
  {
    key: 'approvals', label: 'Approvals (escalations)', note: 'Approve escalated actions (large payouts, regulated steps).', sensitive: true,
    keywords: ['approve', 'approval', 'authorize', 'authorise', 'sign off', 'sign-off', 'manager', 'supervisor', 'escalation', 'oversee'],
    permissions: [p('exception.read'), p('exception.approve')],
  },
  {
    key: 'useradmin', label: 'User & role administration', note: 'Create users, define roles, grant access.', sensitive: true,
    keywords: ['user admin', 'manage user', 'manage staff', 'role', 'permission', 'access control', 'admin', 'administrator', 'team management', 'onboarding staff', 'hr'],
    permissions: [p('user.read'), p('user.manage'), p('role.read'), p('role.manage')],
  },
  {
    key: 'privacy', label: 'Data privacy (LGPD/GDPR)', note: 'Export or erase a data subject’s personal data.', sensitive: true,
    keywords: ['privacy', 'lgpd', 'gdpr', 'data subject', 'erasure', 'right to be forgotten', 'personal data', 'dpo', 'data protection'],
    permissions: [p('privacy.export'), p('privacy.manage')],
  },
  {
    key: 'integrations', label: 'Integrations & devices', note: 'Configure vendors and dispatch device commands (locks, etc.).',
    keywords: ['integration', 'lock', 'door', 'device', 'connector', 'api', 'webhook', 'smart lock', 'access control', 'hardware'],
    permissions: [p('integration.read'), p('connector.dispatch')],
  },
];

/** The permissions that always warrant a second look, regardless of capability. */
const SENSITIVE_PERMS = new Set<string>([
  'deposit.refund', 'bill.pay', 'exception.approve', 'user.manage', 'role.manage',
  'privacy.manage', 'config.manage', 'masterdata.manage', 'persistence.run', 'agreement.execute',
]);

export interface AccessRecommendation {
  /** The capabilities matched from the description. */
  capabilities: Array<{ key: string; label: string; note: string; sensitive: boolean }>;
  /** The union of permissions those capabilities imply (deduped, sorted, valid). */
  permissions: Permission[];
  /** The best least-privilege built-in role, if one cleanly covers the need. */
  suggestedRole: { id: string; name: string; description?: string; extraPermissions: Permission[] } | null;
  /** A ready-to-create custom role when no built-in fits well. */
  proposedRole: { id: string; name: string; permissions: Permission[] } | null;
  /** Plain-language reasons for the recommendation. */
  rationale: string[];
  /** Sensitive grants flagged for review. */
  risks: string[];
  /** 'high' when the description clearly matched capabilities, lower when it was vague. */
  confidence: 'high' | 'medium' | 'low';
}

function expand(role: RoleDef): Set<Permission> {
  return role.permissions === '*' ? new Set(PERMISSIONS) : new Set(role.permissions);
}

function matches(haystack: string, keyword: string): boolean {
  // pad so e.g. ' ap ' only matches the standalone token, not "apartment".
  return (' ' + haystack + ' ').includes(keyword.startsWith(' ') ? keyword : ' ' + keyword.trim());
}

/**
 * Recommend access from a description. Deterministic: the same text always yields
 * the same recommendation. `roleIdHint` seeds the proposed custom-role id.
 */
export function recommendAccess(description: string, roleIdHint?: string): AccessRecommendation {
  const text = (description || '').toLowerCase();
  const matched: Capability[] = [];
  for (const cap of CAPABILITIES) {
    if (cap.keywords.some((k) => matches(text, k))) matched.push(cap);
  }
  // Nothing recognized → default to safe read-only visibility.
  const vague = matched.length === 0;
  if (vague) matched.push(CAPABILITIES.find((c) => c.key === 'view')!);

  const permSet = new Set<Permission>();
  for (const cap of matched) for (const perm of cap.permissions) if (ALL_PERMS.has(perm)) permSet.add(perm);
  const permissions = [...permSet].sort();

  // Closest built-in: a role whose grants COVER the need with the fewest extras
  // (least privilege). Exclude the all-powerful roles unless admin was requested.
  const wantsAdmin = matched.some((c) => c.key === 'useradmin');
  const candidates = BUILTIN_ROLES
    .filter((r) => wantsAdmin || r.permissions !== '*')
    .map((r) => ({ role: r, perms: expand(r) }))
    .filter(({ perms }) => permissions.every((need) => perms.has(need)))
    .map(({ role, perms }) => ({ role, extra: [...perms].filter((x) => !permSet.has(x)).sort() }))
    .sort((a, b) => a.extra.length - b.extra.length);

  let suggestedRole: AccessRecommendation['suggestedRole'] = null;
  let proposedRole: AccessRecommendation['proposedRole'] = null;
  const best = candidates[0];
  // Accept a built-in only if it isn't wildly over-broad (≤ 8 extra perms), else
  // propose an exact custom role. read_only/guest can legitimately carry extras.
  if (best && (best.extra.length <= 8 || best.role.id === 'read_only')) {
    suggestedRole = { id: best.role.id, name: best.role.name, description: best.role.description, extraPermissions: best.extra as Permission[] };
  } else {
    const id = (roleIdHint || matched.map((c) => c.key).slice(0, 2).join('_') || 'custom_role').replace(/[^a-z0-9_]/g, '_');
    const name = matched.map((c) => c.label).slice(0, 2).join(' + ') || 'Custom role';
    proposedRole = { id, name, permissions };
  }

  const rationale: string[] = [];
  rationale.push(vague
    ? 'The description was general, so a safe read-only baseline was recommended — refine it (e.g. mention bookings, payments, maintenance) for a tighter fit.'
    : `Matched ${matched.length} responsibilit${matched.length === 1 ? 'y' : 'ies'}: ${matched.map((c) => c.label).join(', ')}.`);
  if (suggestedRole) {
    rationale.push(suggestedRole.extraPermissions.length === 0
      ? `The built-in role “${suggestedRole.name}” matches these needs exactly.`
      : `The built-in role “${suggestedRole.name}” is the closest least-privilege fit (it also grants ${suggestedRole.extraPermissions.length} adjacent permission${suggestedRole.extraPermissions.length === 1 ? '' : 's'}).`);
  } else if (proposedRole) {
    rationale.push(`No built-in role fit cleanly, so a custom role “${proposedRole.name}” with exactly ${proposedRole.permissions.length} permissions is proposed.`);
  }

  const risks: string[] = [];
  for (const cap of matched) if (cap.sensitive) risks.push(`${cap.label}: ${cap.note}`);
  const grant = suggestedRole ? expand(BUILTIN_ROLES.find((r) => r.id === suggestedRole!.id)!) : new Set(permissions);
  for (const perm of grant) if (SENSITIVE_PERMS.has(perm)) risks.push(`Grants \`${perm}\` — a sensitive, money-moving or administrative capability; confirm this is intended.`);

  return {
    capabilities: matched.map((c) => ({ key: c.key, label: c.label, note: c.note, sensitive: !!c.sensitive })),
    permissions,
    suggestedRole,
    proposedRole,
    rationale,
    risks: [...new Set(risks)],
    confidence: vague ? 'low' : matched.length >= 2 ? 'high' : 'medium',
  };
}
