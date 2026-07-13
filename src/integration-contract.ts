// Per-kind integration CONTRACT — the normalized vocabulary every integration
// port speaks, independent of which vendor sits behind it. This is what makes a
// vendor "pluggable": the agent/portal issue a canonical action (e.g.
// access_control → 'unlock_door') and receive a canonical event (e.g. bank →
// 'transaction_posted'); the per-vendor adapter (src/adapter-registry.ts) only
// TRANSLATES between this contract and the vendor's own API. Pure + zero-dep, so
// the contract is a single source of truth the whole platform can discover.

import type { IntegrationKind } from './integrations.ts';

export interface ActionSpec {
  action: string;
  description: string;
}

/** OUTBOUND: the canonical commands Elara may send to a vendor of this kind. */
export const KIND_ACTIONS: Record<IntegrationKind, readonly ActionSpec[]> = {
  lock: [
    { action: 'unlock', description: 'Unlock a lock, optionally for a window.' },
    { action: 'lock', description: 'Lock a lock.' },
    { action: 'get_status', description: 'Read a lock’s current state.' },
  ],
  access_control: [
    { action: 'unlock_door', description: 'Momentarily unlock a controlled door.' },
    { action: 'grant_access', description: 'Grant a credential access to a door/zone for a window.' },
    { action: 'revoke_access', description: 'Revoke a credential’s access.' },
    { action: 'list_doors', description: 'Enumerate controllable doors/zones.' },
  ],
  elevator: [
    { action: 'call_elevator', description: 'Dispatch an elevator to a floor.' },
    { action: 'grant_floor', description: 'Authorize a credential for a floor for a window.' },
    { action: 'revoke_floor', description: 'Revoke a credential’s floor authorization.' },
  ],
  bank: [
    { action: 'initiate_payout', description: 'Initiate a payout (MONEY RAIL — human-approved adapter only).' },
    { action: 'get_statement', description: 'Fetch account statement lines.' },
    { action: 'get_balance', description: 'Read the account balance.' },
  ],
  payment_gateway: [
    { action: 'charge', description: 'Charge a payment method (MONEY RAIL — human-approved adapter only).' },
    { action: 'refund', description: 'Refund a charge (MONEY RAIL — human-approved adapter only).' },
    { action: 'get_transaction', description: 'Read a transaction’s status.' },
  ],
  website: [
    { action: 'push_inventory', description: 'Publish availability to the website/booking engine.' },
    { action: 'push_rates', description: 'Publish nightly rates.' },
    { action: 'pull_bookings', description: 'Pull new bookings made on the website.' },
  ],
  crm: [
    { action: 'pull_leads', description: 'Pull new leads from the CRM.' },
    { action: 'push_lead', description: 'Push a lead to the CRM.' },
    { action: 'update_lead', description: 'Update a lead’s stage/fields in the CRM.' },
  ],
  fiscal: [
    { action: 'emit_invoice', description: 'Emit an electronic fiscal invoice (e.g. NF-e/NFS-e) for an invoice.' },
    { action: 'cancel_invoice', description: 'Cancel a previously authorized fiscal invoice.' },
    { action: 'get_status', description: 'Read the authorization status of a fiscal invoice.' },
  ],
  screening: [
    { action: 'order_report', description: 'Order a tenant screening report (credit/background/income) for an applicant.' },
    { action: 'get_result', description: 'Read the result of a screening report.' },
  ],
};

/** INBOUND: the canonical events a vendor of this kind may push back to Elara. */
export const KIND_EVENTS: Record<IntegrationKind, readonly string[]> = {
  lock: ['locked', 'unlocked', 'battery_low', 'forced_open'],
  access_control: ['access_granted', 'access_denied', 'door_forced'],
  elevator: ['floor_reached', 'fault'],
  bank: ['transaction_posted', 'payout_settled', 'payout_failed'],
  payment_gateway: ['charge_succeeded', 'charge_failed', 'refund_settled'],
  website: ['booking_created', 'booking_cancelled'],
  crm: ['lead_created', 'lead_updated'],
  fiscal: ['invoice_authorized', 'invoice_rejected', 'invoice_cancelled'],
  screening: ['screening_completed', 'screening_failed'],
};

export function actionsFor(kind: IntegrationKind): readonly ActionSpec[] {
  return KIND_ACTIONS[kind] ?? [];
}

export function isKnownAction(kind: IntegrationKind, action: string): boolean {
  return actionsFor(kind).some((a) => a.action === action);
}

export function isKnownEvent(kind: IntegrationKind, event: string): boolean {
  return (KIND_EVENTS[kind] ?? []).includes(event);
}

/** The whole contract — for capability discovery (GET /integrations/capabilities). */
export function fullContract(): Array<{ kind: IntegrationKind; actions: readonly ActionSpec[]; events: readonly string[] }> {
  return (Object.keys(KIND_ACTIONS) as IntegrationKind[]).map((kind) => ({
    kind,
    actions: KIND_ACTIONS[kind],
    events: KIND_EVENTS[kind],
  }));
}
