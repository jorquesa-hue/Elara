// Master data — the stable reference entities every other module and every
// external integration keys off: units, guests, users, and rate plans. Shapes
// are deliberately flat, id-stable, and tenant-scoped so they map cleanly onto
// API payloads and reporting rows without transformation. A `code` field on
// each entity is the human/external-system-facing stable key (distinct from the
// internal id) — the anchor for API connectivity and report joins.

export interface UnitRecord {
  id: string;
  tenantId: string;
  code: string; // external/reporting key, e.g. "RIO-101"
  label: string;
  active: boolean;
}

export interface GuestRecord {
  id: string;
  tenantId: string;
  code: string;
  fullName: string;
  email?: string;
}

export interface UserRecord {
  id: string;
  tenantId: string;
  code: string;
  displayName: string;
  roleId: string; // resolves against RoleRegistry
  active: boolean;
}

export interface RatePlanRecord {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  kind: 'nightly' | 'monthly' | 'lease';
  baseMinor: number; // amount in the tenant currency's minor unit
}

export class MasterDataError extends Error {}

class Registry<T extends { id: string; tenantId: string; code: string }> {
  private byId = new Map<string, T>();

  constructor(private readonly kind: string) {}

  add(record: T): T {
    if (this.byId.has(record.id)) throw new MasterDataError(`duplicate ${this.kind}: ${record.id}`);
    if (!record.code) throw new MasterDataError(`${this.kind} ${record.id}: code is required`);
    // Codes are unique per tenant (reporting/API join key).
    for (const r of this.byId.values()) {
      if (r.tenantId === record.tenantId && r.code === record.code) {
        throw new MasterDataError(`${this.kind} code '${record.code}' already used in tenant ${record.tenantId}`);
      }
    }
    this.byId.set(record.id, { ...record });
    return { ...record };
  }

  get(tenantId: string, id: string): T | null {
    const r = this.byId.get(id);
    return r && r.tenantId === tenantId ? { ...r } : null;
  }

  list(tenantId: string): T[] {
    return [...this.byId.values()].filter((r) => r.tenantId === tenantId).map((r) => ({ ...r }));
  }

  update(tenantId: string, id: string, patch: Partial<T>): T {
    const r = this.byId.get(id);
    if (!r || r.tenantId !== tenantId) throw new MasterDataError(`unknown ${this.kind}: ${id}`);
    const next = { ...r, ...patch, id: r.id, tenantId: r.tenantId };
    this.byId.set(id, next);
    return { ...next };
  }
}

export class MasterData {
  readonly units = new Registry<UnitRecord>('unit');
  readonly guests = new Registry<GuestRecord>('guest');
  readonly users = new Registry<UserRecord>('user');
  readonly ratePlans = new Registry<RatePlanRecord>('rate_plan');

  /** A compact, reporting-friendly snapshot of a tenant's master data. */
  snapshot(tenantId: string) {
    return {
      units: this.units.list(tenantId),
      guests: this.guests.list(tenantId),
      users: this.users.list(tenantId),
      ratePlans: this.ratePlans.list(tenantId),
    };
  }
}
