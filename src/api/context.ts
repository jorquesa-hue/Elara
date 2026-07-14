// Auth boundary for the Public API. A bearer token resolves to an
// AuthContext; every request is tenant-scoped from it (mirrors the DB's
// deny-by-default RLS — no tenant claim, no access). Roles gate sensitive
// operations: an 'agent' cannot approve its own escalations.

import { createHmac, timingSafeEqual, createPublicKey, verify as cryptoVerify } from 'node:crypto';

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
  /**
   * The legal entity this token acts as, when the caller is an OWNER/INVESTOR
   * rather than an operator or resident. Owner-portal reads are constrained to
   * this entity's properties + distributions. Undefined for operator/resident
   * tokens (orthogonal to partyId — a token is at most one of the two).
   */
  entityId?: string;
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
  /** The owning legal entity, for an owner/investor token (owner portal). */
  entityId: string;
  /** The subject/actor identifier. */
  actor: string;
}

const DEFAULT_CLAIM_MAP: JwtClaimMap = {
  role: 'user_role',
  tenantId: 'tenant_id',
  partyId: 'party_id',
  entityId: 'entity_id',
  actor: 'sub',
};

export class JwtError extends Error {}

function b64urlToBuffer(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

/** A public key from a JWKS (JSON Web Key Set), used to verify asymmetric JWTs. */
export type Jwk = Record<string, unknown> & { kid?: string; kty?: string; alg?: string; use?: string };

/**
 * Production authenticator: verifies a signed JWT and derives the AuthContext
 * from its claims. It reads the SAME `tenant_id` claim the DB's RLS keys off, so
 * app-level and row-level tenant isolation agree. `node:crypto` is a platform
 * builtin — no npm dependency is added (invariant 7 stays intact).
 *
 * Supports BOTH signing modes Supabase can be configured with:
 *   • HS256 with a shared secret (the legacy JWT secret / GoTrue HMAC key), and
 *   • RS256/ES256 with the project's asymmetric SIGNING KEYS, verified against the
 *     public keys published at the JWKS endpoint (fetched at boot, injected here).
 * A token is accepted if its alg + key material verify by either path — so a
 * project on the new asymmetric keys, the legacy secret, or mid-migration all work.
 *
 * Deliberately strict: `alg: none` is refused, exp/nbf are checked, and a
 * tenant_id is REQUIRED (no tenant claim → no access, mirroring deny-by-default RLS).
 */
export class JwtAuthenticator implements Authenticator {
  private readonly secret?: string;
  private jwks: Jwk[];
  private readonly now: () => number;
  private readonly claims: JwtClaimMap;
  private readonly leewaySec: number;

  constructor(opts: {
    /** HS256 shared secret. Optional if `jwks` is supplied (asymmetric-only project). */
    secret?: string;
    /** Public keys for asymmetric (RS256/ES256) verification (from the JWKS endpoint). */
    jwks?: Jwk[];
    /** Seconds since epoch; defaults to Date.now()/1000. Injectable for tests. */
    now?: () => number;
    claimMap?: Partial<JwtClaimMap>;
    /** Clock-skew tolerance for exp/nbf, in seconds (default 0). */
    leewaySec?: number;
  }) {
    if (!opts.secret && !(opts.jwks && opts.jwks.length > 0)) {
      throw new JwtError('JwtAuthenticator requires a signing secret or a JWKS');
    }
    this.secret = opts.secret;
    this.jwks = opts.jwks ?? [];
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
    this.claims = { ...DEFAULT_CLAIM_MAP, ...(opts.claimMap ?? {}) };
    this.leewaySec = opts.leewaySec ?? 0;
  }

  /** Replace the asymmetric public keys (e.g. after a periodic JWKS refresh). */
  setJwks(jwks: Jwk[]): void {
    this.jwks = jwks ?? [];
  }

  /** Verify the `header.payload` signature for the token's declared algorithm.
   *  HS256 uses the shared secret (constant-time HMAC); RS/ES families use the
   *  matching JWKS public key. Any unknown alg (incl. `none`) fails closed. */
  private verifySignature(alg: string, kid: string | undefined, signingInput: string, sig: Buffer): boolean {
    if (alg === 'HS256') {
      if (!this.secret) return false;
      const expected = createHmac('sha256', this.secret).update(signingInput).digest();
      return sig.length === expected.length && timingSafeEqual(sig, expected);
    }
    const asym = /^(RS|ES)(256|384|512)$/.exec(alg);
    if (!asym) return false; // reject alg:none and everything unlisted
    const wantKty = asym[1] === 'RS' ? 'RSA' : 'EC';
    const jwk = this.jwks.find(
      (k) => (kid ? k.kid === kid : true) && (k.kty === wantKty) && (k.use === undefined || k.use === 'sig'),
    );
    if (!jwk) return false;
    try {
      const key = createPublicKey({ key: jwk as never, format: 'jwk' });
      const data = Buffer.from(signingInput);
      if (asym[1] === 'RS') return cryptoVerify(`RSA-SHA${asym[2]}`, data, key, sig);
      // JWT ECDSA signatures are raw r||s (IEEE P1363), not the DER node expects by default.
      return cryptoVerify(`sha${asym[2]}`, data, { key, dsaEncoding: 'ieee-p1363' }, sig);
    } catch {
      return false;
    }
  }

  authenticate(bearer: string | undefined): AuthContext | null {
    if (!bearer) return null;
    const token = bearer.replace(/^Bearer\s+/i, '').trim();
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [headB64, payloadB64, sigB64] = parts as [string, string, string];

    // 1. Parse the header. typ, when present, must be JWT.
    let header: Record<string, unknown>;
    try {
      header = JSON.parse(b64urlToBuffer(headB64).toString('utf8'));
    } catch {
      return null;
    }
    if (header['typ'] !== undefined && header['typ'] !== 'JWT') return null;
    const alg = typeof header['alg'] === 'string' ? header['alg'] : '';
    const kid = typeof header['kid'] === 'string' ? header['kid'] : undefined;

    // 2. Verify the signature over `header.payload` for the declared algorithm.
    let provided: Buffer;
    try {
      provided = b64urlToBuffer(sigB64);
    } catch {
      return null;
    }
    if (!this.verifySignature(alg, kid, `${headB64}.${payloadB64}`, provided)) return null;

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
    const entityId = pick(this.claims.entityId);

    return {
      actor, tenantId, role,
      ...(partyId ? { partyId } : {}),
      ...(entityId ? { entityId } : {}),
    };
  }
}
