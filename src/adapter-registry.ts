// Pluggable vendor ADAPTER registry — the "drop-in a file per vendor" mechanism.
// An adapter is a PURE translator: it turns a canonical command (from the
// integration contract) into a vendor HTTP request TEMPLATE. It never sees the
// credential — the request carries an `auth` descriptor telling the runtime edge
// how to inject the resolved secret at call time, so no credential ever enters the
// kernel (invariant discipline). Onboarding a vendor = register one adapter here;
// the kernel, policy, outbox, and every other tenant stay untouched.

import type { IntegrationKind } from './integrations.ts';
import { isKnownAction } from './integration-contract.ts';

/** How the runtime edge injects the resolved secret into the vendor request. The
 *  secret itself is NEVER in the template — only a descriptor of where it goes. */
export type AuthScheme =
  | { scheme: 'none' }
  | { scheme: 'bearer' } // Authorization: Bearer <secret>
  | { scheme: 'header'; name: string } // <name>: <secret>
  | { scheme: 'basic'; username: string }; // Authorization: Basic base64(username:<secret>)

export interface VendorRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  auth: AuthScheme;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface Adapter {
  kind: IntegrationKind;
  provider: string;
  /** Canonical contract actions this adapter implements. */
  actions: readonly string[];
  /** MONEY RAILS ship disabled: the port exists but a payout/charge is refused
   *  until a human enables the adapter with real credentials (guardrail). */
  enabled: boolean;
  /** Pure: canonical command → vendor request template. Throws on an unsupported
   *  action or missing required config. Must not read any credential. */
  buildRequest(action: string, payload: Record<string, unknown>, config: Record<string, unknown>): VendorRequest;
}

export class AdapterError extends Error {}

const enc = (v: unknown): string => encodeURIComponent(String(v ?? ''));
const baseUrl = (config: Record<string, unknown>, provider: string): string => {
  const b = String(config['baseUrl'] ?? '').replace(/\/+$/, '');
  if (!b) throw new AdapterError(`${provider}: config.baseUrl is required`);
  return b;
};

export class AdapterRegistry {
  private byKey = new Map<string, Adapter>();
  private key(kind: string, provider: string): string { return `${kind}:${provider}`; }

  /** Register an adapter; its actions are validated against the kind's contract. */
  register(adapter: Adapter): this {
    for (const a of adapter.actions) {
      if (!isKnownAction(adapter.kind, a)) {
        throw new AdapterError(`adapter ${adapter.provider}: '${a}' is not a '${adapter.kind}' contract action`);
      }
    }
    this.byKey.set(this.key(adapter.kind, adapter.provider), adapter);
    return this;
  }

  resolve(kind: IntegrationKind, provider: string): Adapter | null {
    return this.byKey.get(this.key(kind, provider)) ?? null;
  }

  list(): Adapter[] {
    return [...this.byKey.values()];
  }
}

// --- reference adapters (generic, pure translators) ------------------------
// A concrete vendor (salto, yale, itau, …) is a copy of one of these with the
// real endpoints filled in. These use a `generic_rest`/`generic_webhook` provider
// so a customer running any REST-ish system can connect by pointing config.baseUrl.

export const genericRestLock: Adapter = {
  kind: 'lock',
  provider: 'generic_rest',
  actions: ['unlock', 'lock', 'get_status'],
  enabled: true,
  buildRequest(action, payload, config) {
    const base = baseUrl(config, 'generic_rest lock');
    const lockId = enc(payload['lockId']);
    switch (action) {
      case 'unlock': return { method: 'POST', url: `${base}/locks/${lockId}/unlock`, auth: { scheme: 'bearer' }, body: { until: payload['until'] ?? null } };
      case 'lock': return { method: 'POST', url: `${base}/locks/${lockId}/lock`, auth: { scheme: 'bearer' } };
      case 'get_status': return { method: 'GET', url: `${base}/locks/${lockId}`, auth: { scheme: 'bearer' } };
      default: throw new AdapterError(`generic_rest lock: unsupported action '${action}'`);
    }
  },
};

export const genericRestAccessControl: Adapter = {
  kind: 'access_control',
  provider: 'generic_rest',
  actions: ['unlock_door', 'grant_access', 'revoke_access', 'list_doors'],
  enabled: true,
  buildRequest(action, payload, config) {
    const base = baseUrl(config, 'generic_rest access_control');
    switch (action) {
      case 'unlock_door': return { method: 'POST', url: `${base}/doors/${enc(payload['doorId'])}/unlock`, auth: { scheme: 'bearer' }, body: { until: payload['until'] ?? null } };
      case 'grant_access': return { method: 'POST', url: `${base}/access`, auth: { scheme: 'bearer' }, body: { credential: payload['credential'], doorId: payload['doorId'], until: payload['until'] ?? null } };
      case 'revoke_access': return { method: 'DELETE', url: `${base}/access/${enc(payload['credential'])}`, auth: { scheme: 'bearer' } };
      case 'list_doors': return { method: 'GET', url: `${base}/doors`, auth: { scheme: 'bearer' } };
      default: throw new AdapterError(`generic_rest access_control: unsupported action '${action}'`);
    }
  },
};

export const genericWebhookWebsite: Adapter = {
  kind: 'website',
  provider: 'generic_webhook',
  actions: ['push_inventory', 'push_rates', 'pull_bookings'],
  enabled: true,
  buildRequest(action, payload, config) {
    const base = baseUrl(config, 'generic_webhook website');
    switch (action) {
      // Snapshot the body (see the fiscal adapter): the caller assigns the request
      // back onto the same payload, so `body: payload` would create a cycle.
      case 'push_inventory': return { method: 'POST', url: `${base}/inventory`, auth: { scheme: 'header', name: 'X-Api-Key' }, body: { ...payload } };
      case 'push_rates': return { method: 'POST', url: `${base}/rates`, auth: { scheme: 'header', name: 'X-Api-Key' }, body: { ...payload } };
      case 'pull_bookings': return { method: 'GET', url: `${base}/bookings?since=${enc(payload['since'])}`, auth: { scheme: 'header', name: 'X-Api-Key' } };
      default: throw new AdapterError(`generic_webhook website: unsupported action '${action}'`);
    }
  },
};

// A bank port TEMPLATE — declared so the money rail's port EXISTS, but shipped
// DISABLED: a payout adapter is enabled only with explicit human approval + real
// credentials. (planConnectorCommand also refuses money kinds at the drain edge.)
export const genericRestBank: Adapter = {
  kind: 'bank',
  provider: 'generic_rest',
  actions: ['initiate_payout', 'get_statement', 'get_balance'],
  enabled: false,
  buildRequest(action, payload, config) {
    const base = baseUrl(config, 'generic_rest bank');
    switch (action) {
      case 'initiate_payout': return { method: 'POST', url: `${base}/payouts`, auth: { scheme: 'bearer' }, body: { amountCents: payload['amountCents'], to: payload['to'] } };
      case 'get_statement': return { method: 'GET', url: `${base}/statement?from=${enc(payload['from'])}&to=${enc(payload['to'])}`, auth: { scheme: 'bearer' } };
      case 'get_balance': return { method: 'GET', url: `${base}/balance`, auth: { scheme: 'bearer' } };
      default: throw new AdapterError(`generic_rest bank: unsupported action '${action}'`);
    }
  },
};

// A fiscal-document port (NF-e / NFS-e emission). This is NOT a money rail — it
// emits a tax document for money that already settled — so it ships ENABLED. A
// real provider (Focus NFe, NFe.io, eNotas, a municipal NFS-e gateway) is a copy
// of this with the real endpoints; the certificate/API key is resolved by the edge
// from the secret store (never in the kernel). The emitted document's authorization
// comes back asynchronously via the inbound events port (fiscal.invoice_authorized).
export const genericFiscal: Adapter = {
  kind: 'fiscal',
  provider: 'generic_rest',
  actions: ['emit_invoice', 'cancel_invoice', 'get_status'],
  enabled: true,
  buildRequest(action, payload, config) {
    const base = baseUrl(config, 'generic_rest fiscal');
    switch (action) {
      // Snapshot the body — the caller assigns the built request back onto the same
      // payload object (payload._request = req), so `body: payload` would make a cycle.
      case 'emit_invoice': return { method: 'POST', url: `${base}/nfe`, auth: { scheme: 'bearer' }, body: { ...payload } };
      case 'cancel_invoice': return { method: 'POST', url: `${base}/nfe/${enc(payload['fiscalRef'] ?? payload['invoiceId'])}/cancel`, auth: { scheme: 'bearer' }, body: { reason: payload['reason'] ?? null } };
      case 'get_status': return { method: 'GET', url: `${base}/nfe/${enc(payload['fiscalRef'] ?? payload['invoiceId'])}`, auth: { scheme: 'bearer' } };
      default: throw new AdapterError(`generic_rest fiscal: unsupported action '${action}'`);
    }
  },
};

/** The default registry: the generic reference adapters. A deployment adds its
 *  real vendor adapters on top (or swaps a generic one for a vendor-specific one). */
export function defaultAdapterRegistry(): AdapterRegistry {
  return new AdapterRegistry()
    .register(genericRestLock)
    .register(genericRestAccessControl)
    .register(genericWebhookWebsite)
    .register(genericRestBank)
    .register(genericFiscal);
}
