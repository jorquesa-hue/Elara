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
  /** Optional floorplan/unit-type this unit belongs to (multifamily portfolios). */
  typeId?: string;
  /** Optional property/community this unit belongs to — the rollup dimension for
   *  a multi-property operator (per-property rent roll, occupancy, P&L, owner
   *  statements). Undefined for single-property/legacy tenants. */
  propertyId?: string;
}

/** A property / community — the top-level portfolio rollup a multi-property
 *  operator (e.g. a third-party manager running hundreds of communities)
 *  reports and compares on. Units belong to a property; a property optionally
 *  belongs to an owning legal entity (the SPE/landlord), which is how owner
 *  statements and per-entity books are scoped. */
export interface PropertyRecord {
  id: string;
  tenantId: string;
  code: string; // e.g. "GREYSTONE"
  name: string; // e.g. "Greystone at Riverside"
  address?: string;
  /** The owning legal entity (EntityCatalog id) — scopes owner statements. */
  entityId?: string;
}

/** A floorplan / unit type — the multifamily unit of merchandising. A 200-unit
 *  building is a handful of types (1BR, 2BR…) with units hanging off them:
 *  marketing details, base rent and reporting group live on the TYPE so they
 *  are entered once, not 200 times. */
export interface UnitTypeRecord {
  id: string;
  tenantId: string;
  code: string; // e.g. "1BR-A"
  name: string; // e.g. "One bedroom — Garden"
  bedrooms?: number;
  bathrooms?: number;
  maxGuests?: number;
  areaSqm?: number;
  baseRentCents?: number; // market/asking rent for the type
  description?: string;
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
  readonly unitTypes = new Registry<UnitTypeRecord>('unit_type');
  readonly properties = new Registry<PropertyRecord>('property');
  readonly guests = new Registry<GuestRecord>('guest');
  readonly users = new Registry<UserRecord>('user');
  readonly ratePlans = new Registry<RatePlanRecord>('rate_plan');

  /** A compact, reporting-friendly snapshot of a tenant's master data. */
  snapshot(tenantId: string) {
    return {
      units: this.units.list(tenantId),
      unitTypes: this.unitTypes.list(tenantId),
      properties: this.properties.list(tenantId),
      guests: this.guests.list(tenantId),
      users: this.users.list(tenantId),
      ratePlans: this.ratePlans.list(tenantId),
    };
  }
}
