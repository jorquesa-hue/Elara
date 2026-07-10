// Auth boundary for the Public API. A bearer token resolves to an
// AuthContext; every request is tenant-scoped from it (mirrors the DB's
// deny-by-default RLS — no tenant claim, no access). Roles gate sensitive
// operations: an 'agent' cannot approve its own escalations.

import { createHmac, timingSafeEqual } from 'node:crypto';

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
  /**
   * The party this token acts as, when the caller is a guest/resident rather than
   * an operator user. Reads for a party-scoped role (e.g. `guest`) are constrained
   * to agreements this party is linked to. Undefined for operator/staff tokens.
   */
  partyId?: string;
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

/** Which JWT claims carry the AuthContext fields. Each falls back to the same
 *  key nested under `app_metadata` (where Supabase stows app-controlled claims). */
export interface JwtClaimMap {
  /** The application role (owner/manager/agent/guest/...). NOT Postgres's
   *  authenticated/anon/service_role — that lives in the standard `role` claim. */
  role: string;
  tenantId: string;
  partyId: string;
  /** The subject/actor identifier. */
  actor: string;
}

const DEFAULT_CLAIM_MAP: JwtClaimMap = {
  role: 'user_role',
  tenantId: 'tenant_id',
  partyId: 'party_id',
  actor: 'sub',
};

export class JwtError extends Error {}

function b64urlToBuffer(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

/**
 * Production authenticator: verifies an HS256-signed JWT with a shared secret
 * (the Supabase JWT secret / GoTrue signing key), then derives the AuthContext
 * from its claims. It reads the SAME `tenant_id` claim the DB's RLS keys off, so
 * app-level and row-level tenant isolation agree. `node:crypto` is a platform
 * builtin — no npm dependency is added (invariant 7 stays intact).
 *
 * Deliberately minimal and strict: only HS256, signature + exp/nbf checked, and a
 * tenant_id is REQUIRED (no tenant claim → no access, mirroring deny-by-default RLS).
 */
export class JwtAuthenticator implements Authenticator {
  private readonly secret: string;
  private readonly now: () => number;
  private readonly claims: JwtClaimMap;
  private readonly leewaySec: number;

  constructor(opts: {
    secret: string;
    /** Seconds since epoch; defaults to Date.now()/1000. Injectable for tests. */
    now?: () => number;
    claimMap?: Partial<JwtClaimMap>;
    /** Clock-skew tolerance for exp/nbf, in seconds (default 0). */
    leewaySec?: number;
  }) {
    if (!opts.secret) throw new JwtError('JwtAuthenticator requires a signing secret');
    this.secret = opts.secret;
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
    this.claims = { ...DEFAULT_CLAIM_MAP, ...(opts.claimMap ?? {}) };
    this.leewaySec = opts.leewaySec ?? 0;
  }

  authenticate(bearer: string | undefined): AuthContext | null {
    if (!bearer) return null;
    const token = bearer.replace(/^Bearer\s+/i, '').trim();
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [headB64, payloadB64, sigB64] = parts as [string, string, string];

    // 1. Header must declare HS256 (we do not accept `alg: none` or others).
    let header: Record<string, unknown>;
    try {
      header = JSON.parse(b64urlToBuffer(headB64).toString('utf8'));
    } catch {
      return null;
    }
    if (header['alg'] !== 'HS256' || (header['typ'] !== undefined && header['typ'] !== 'JWT')) {
      return null;
    }

    // 2. Verify the signature over `header.payload` in constant time.
    const expected = createHmac('sha256', this.secret).update(`${headB64}.${payloadB64}`).digest();
    let provided: Buffer;
    try {
      provided = b64urlToBuffer(sigB64);
    } catch {
      return null;
    }
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;

    // 3. Decode + validate temporal claims.
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(b64urlToBuffer(payloadB64).toString('utf8'));
    } catch {
      return null;
    }
    const now = this.now();
    const exp = payload['exp'];
    if (typeof exp === 'number' && now > exp + this.leewaySec) return null; // expired
    const nbf = payload['nbf'];
    if (typeof nbf === 'number' && now + this.leewaySec < nbf) return null; // not yet valid

    // 4. Pull the AuthContext claims (top-level, else nested under app_metadata).
    const meta = (payload['app_metadata'] && typeof payload['app_metadata'] === 'object'
      ? (payload['app_metadata'] as Record<string, unknown>)
      : {});
    const pick = (key: string): string | undefined => {
      const v = payload[key] ?? meta[key];
      return typeof v === 'string' && v.length > 0 ? v : undefined;
    };

    const tenantId = pick(this.claims.tenantId);
    if (!tenantId) return null; // no tenant claim → no access (deny-by-default)
    const actor = pick(this.claims.actor) ?? tenantId;
    const role: Role = pick(this.claims.role) ?? 'read_only';
    const partyId = pick(this.claims.partyId);

    return partyId ? { actor, tenantId, role, partyId } : { actor, tenantId, role };
  }
}
