// Auth boundary for the Public API. A bearer token resolves to an
// AuthContext; every request is tenant-scoped from it (mirrors the DB's
// deny-by-default RLS — no tenant claim, no access). Roles gate sensitive
// operations: an 'agent' cannot approve its own escalations.

// A role id. Built-in ids are suggested for autocomplete; any string is valid so
// tenants can reference their own custom roles (see src/rbac.ts).
export type Role =
  | 'owner'
  | 'service'
  | 'manager'
  | 'staff'
  | 'front_desk'
  | 'accountant'
  | 'agent'
  | 'read_only'
  | 'guest'
  | (string & {});

export interface AuthContext {
  actor: string;
  tenantId: string;
  role: Role;
}

export interface Authenticator {
  authenticate(bearer: string | undefined): AuthContext | null;
}

/**
 * Simple static token → context map. Real deployments swap this for a JWT
 * verifier that reads the tenant_id claim (the same claim the DB RLS uses).
 * The kernel/API never embeds real secrets.
 */
export class StaticTokenAuthenticator implements Authenticator {
  private readonly tokens: Map<string, AuthContext>;

  constructor(tokens: Record<string, AuthContext> = {}) {
    this.tokens = new Map(Object.entries(tokens));
  }

  register(token: string, ctx: AuthContext): void {
    this.tokens.set(token, ctx);
  }

  authenticate(bearer: string | undefined): AuthContext | null {
    if (!bearer) return null;
    const token = bearer.replace(/^Bearer\s+/i, '').trim();
    return this.tokens.get(token) ?? null;
  }
}
