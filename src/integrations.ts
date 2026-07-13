// Connector framework — the shared spine for hardware and external-service
// integrations: door locks (#7), access control (#12), elevators (#13), banks &
// payment routing (#14), the website (#16), and CRM (#17).
//
// Boundary discipline (so the kernel stays zero-dependency AND never holds a
// credential): this module models only the *configuration* of an integration
// (non-secret) and an *outbox* of policy-gated commands. The actual vendor I/O
// lives in edge adapters that resolve a `secretRef` against the deployment's
// secret store (Supabase Vault / env) — a real credential is NEVER passed to or
// stored by the kernel. register() actively rejects secret-looking config keys.

export type IntegrationKind =
  | 'lock' | 'access_control' | 'elevator' | 'bank' | 'payment_gateway' | 'website' | 'crm' | 'fiscal' | 'screening' | 'ils';

export type IntegrationStatus = 'active' | 'disabled';

export interface IntegrationRecord {
  id: string;
  tenantId: string;
  kind: IntegrationKind;
  provider: string; // 'salto', 'yale', 'dlock', 'stripe', 'salesforce', …
  status: IntegrationStatus;
  config: Record<string, unknown>; // non-secret settings only
  secretRef?: string; // name of a credential in the secret store — never the value
  createdAt: string;
}

export const INTEGRATION_KINDS: readonly IntegrationKind[] = [
  'lock', 'access_control', 'elevator', 'bank', 'payment_gateway', 'website', 'crm', 'fiscal', 'screening', 'ils',
];

// Substrings that mark a key as secret-bearing. A key is collapsed to
// lowercase alphanumerics first, so snake_case, kebab-case AND camelCase all
// reduce to the same form (access_token / access-token / accessToken ->
// 'accesstoken', which contains 'token'). Substring (not exact) matching means
// 'clientSecret', 'secretKey', 'refreshToken' etc. are all caught.
const SECRET_SUBSTRINGS = [
  'secret', 'password', 'passwd', 'apikey', 'token', 'credential',
  'privatekey', 'accesskey', 'passphrase', 'authorization',
];
// Short, ambiguous tokens matched only exactly (substring would over-reject,
// e.g. 'pin' inside 'shipping').
const SECRET_EXACT = new Set(['pin', 'otp', 'cvv']);

function isSecretKey(key: string): boolean {
  const collapsed = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (SECRET_EXACT.has(collapsed)) return true;
  return SECRET_SUBSTRINGS.some((s) => collapsed.includes(s));
}

export class IntegrationError extends Error {}

// Recursively reject secret-like keys — a credential nested inside an object or
// array (e.g. { auth: { accessToken: '…' } }) must not slip past into the DB.
// The same guard protects both integration config and connector-command
// payloads, since both are persisted verbatim as jsonb.
export function assertNoSecrets(value: unknown, where = 'config'): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoSecrets(item, where);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isSecretKey(k)) {
      throw new IntegrationError(
        `${where} may not contain the secret-like key '${k}'; store the credential in the secret store and pass a secretRef`,
      );
    }
    assertNoSecrets(v, where);
  }
}

export class Integrations {
  private byId = new Map<string, IntegrationRecord>();

  /** Load stored integrations for cold-start rehydration. */
  hydrate(records: readonly IntegrationRecord[]): void {
    for (const r of records) this.byId.set(r.id, { ...r, config: { ...r.config } });
  }

  register(input: {
    id: string;
    tenantId: string;
    kind: IntegrationKind;
    provider: string;
    createdAt: string;
    config?: Record<string, unknown>;
    secretRef?: string;
  }): IntegrationRecord {
    if (this.byId.has(input.id)) throw new IntegrationError(`duplicate integration: ${input.id}`);
    if (!INTEGRATION_KINDS.includes(input.kind)) throw new IntegrationError(`unknown integration kind: ${input.kind}`);
    if (!input.provider) throw new IntegrationError(`integration ${input.id}: provider is required`);
    const config = input.config ?? {};
    assertNoSecrets(config);
    const rec: IntegrationRecord = {
      id: input.id,
      tenantId: input.tenantId,
      kind: input.kind,
      provider: input.provider,
      status: 'active',
      config: { ...config },
      secretRef: input.secretRef,
      createdAt: input.createdAt,
    };
    this.byId.set(rec.id, rec);
    return { ...rec, config: { ...rec.config } };
  }

  get(id: string): IntegrationRecord {
    const r = this.byId.get(id);
    if (!r) throw new IntegrationError(`unknown integration: ${id}`);
    return { ...r, config: { ...r.config } };
  }

  setStatus(id: string, status: IntegrationStatus): IntegrationRecord {
    const r = this.byId.get(id);
    if (!r) throw new IntegrationError(`unknown integration: ${id}`);
    r.status = status;
    return this.get(id);
  }

  list(tenantId: string, filter: { kind?: IntegrationKind } = {}): IntegrationRecord[] {
    return [...this.byId.values()]
      .filter((r) => r.tenantId === tenantId && (filter.kind === undefined || r.kind === filter.kind))
      .map((r) => ({ ...r, config: { ...r.config } }));
  }
}

// --- outbound command outbox -----------------------------------------------

export type CommandStatus = 'pending' | 'dispatched' | 'succeeded' | 'failed';

export interface ConnectorCommand {
  id: string;
  tenantId: string;
  integrationId: string;
  action: string; // 'lock.unlock', 'website.push_inventory', 'crm.pull_leads', …
  payload: Record<string, unknown>;
  status: CommandStatus;
  createdAt: string;
  dispatchedAt?: string;
  resolvedAt?: string;
  result?: Record<string, unknown>;
}

export class ConnectorOutbox {
  private byId = new Map<string, ConnectorCommand>();

  /** Load stored connector commands for cold-start rehydration. */
  hydrate(records: readonly ConnectorCommand[]): void {
    for (const r of records) this.byId.set(r.id, { ...r });
  }

  enqueue(input: {
    id: string;
    tenantId: string;
    integrationId: string;
    action: string;
    createdAt: string;
    payload?: Record<string, unknown>;
  }): ConnectorCommand {
    if (this.byId.has(input.id)) throw new IntegrationError(`duplicate command: ${input.id}`);
    if (!input.action) throw new IntegrationError(`command ${input.id}: action is required`);
    // A command payload is persisted verbatim as jsonb; a credential must never
    // travel this path — the edge worker resolves the integration's secretRef.
    assertNoSecrets(input.payload ?? {}, 'payload');
    const cmd: ConnectorCommand = {
      id: input.id,
      tenantId: input.tenantId,
      integrationId: input.integrationId,
      action: input.action,
      payload: { ...(input.payload ?? {}) },
      status: 'pending',
      createdAt: input.createdAt,
    };
    this.byId.set(cmd.id, cmd);
    return this.get(cmd.id);
  }

  get(id: string): ConnectorCommand {
    const c = this.byId.get(id);
    if (!c) throw new IntegrationError(`unknown command: ${id}`);
    return { ...c, payload: { ...c.payload }, result: c.result ? { ...c.result } : undefined };
  }

  /** An edge worker claims a pending command. */
  markDispatched(id: string, at: string): ConnectorCommand {
    const c = this.byId.get(id);
    if (!c) throw new IntegrationError(`unknown command: ${id}`);
    if (c.status !== 'pending') throw new IntegrationError(`command ${id} is ${c.status}; expected pending`);
    c.status = 'dispatched';
    c.dispatchedAt = at;
    return this.get(id);
  }

  /** The edge worker reports the outcome. */
  markResult(id: string, ok: boolean, at: string, result?: Record<string, unknown>): ConnectorCommand {
    const c = this.byId.get(id);
    if (!c) throw new IntegrationError(`unknown command: ${id}`);
    if (c.status === 'succeeded' || c.status === 'failed') throw new IntegrationError(`command ${id} is already ${c.status}`);
    c.status = ok ? 'succeeded' : 'failed';
    c.resolvedAt = at;
    if (result) c.result = { ...result };
    return this.get(id);
  }

  pending(tenantId: string): ConnectorCommand[] {
    return this.list(tenantId, { status: 'pending' });
  }

  list(tenantId: string, filter: { status?: CommandStatus; integrationId?: string } = {}): ConnectorCommand[] {
    return [...this.byId.values()]
      .filter(
        (c) =>
          c.tenantId === tenantId &&
          (filter.status === undefined || c.status === filter.status) &&
          (filter.integrationId === undefined || c.integrationId === filter.integrationId),
      )
      .map((c) => this.get(c.id));
  }
}
