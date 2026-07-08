// Legal entities & the charge catalog. A tenant may operate through several
// legal entities — the operating company, the condominium association, a
// landlord SPE. A charge_type is master data that routes money to the right
// entity and GL account, so rent and condominium fees land in different books
// (#11) and one invoice always belongs to exactly one receiving entity.

export type EntityRole = 'operator' | 'condominium' | 'landlord' | 'spe';

export const ENTITY_ROLES: readonly EntityRole[] = ['operator', 'condominium', 'landlord', 'spe'];

export interface LegalEntityRecord {
  id: string;
  tenantId: string;
  role: EntityRole;
  name: string;
  taxId?: string;
}

export interface ChargeTypeRecord {
  id: string;
  tenantId: string;
  code: string; // rent, condo_fee, utility, amenity, deposit, late_fee, ...
  name: string;
  receivingEntityId: string;
  glAccount: string;
  recurring: boolean;
}

export class EntityError extends Error {}

export class EntityCatalog {
  private entities = new Map<string, LegalEntityRecord>();
  private charges = new Map<string, ChargeTypeRecord>();

  addEntity(rec: LegalEntityRecord): LegalEntityRecord {
    if (this.entities.has(rec.id)) throw new EntityError(`duplicate legal entity: ${rec.id}`);
    if (!ENTITY_ROLES.includes(rec.role)) throw new EntityError(`legal entity ${rec.id}: unknown role ${rec.role}`);
    this.entities.set(rec.id, { ...rec });
    return { ...rec };
  }

  getEntity(tenantId: string, id: string): LegalEntityRecord | null {
    const e = this.entities.get(id);
    return e && e.tenantId === tenantId ? { ...e } : null;
  }

  listEntities(tenantId: string): LegalEntityRecord[] {
    return [...this.entities.values()].filter((e) => e.tenantId === tenantId).map((e) => ({ ...e }));
  }

  addChargeType(rec: ChargeTypeRecord): ChargeTypeRecord {
    if (this.charges.has(rec.id)) throw new EntityError(`duplicate charge type: ${rec.id}`);
    const entity = this.entities.get(rec.receivingEntityId);
    if (!entity || entity.tenantId !== rec.tenantId) {
      throw new EntityError(`charge type ${rec.id}: receiving entity ${rec.receivingEntityId} not found in tenant`);
    }
    for (const c of this.charges.values()) {
      if (c.tenantId === rec.tenantId && c.code === rec.code) {
        throw new EntityError(`charge code '${rec.code}' already used in tenant ${rec.tenantId}`);
      }
    }
    this.charges.set(rec.id, { ...rec });
    return { ...rec };
  }

  chargeType(tenantId: string, id: string): ChargeTypeRecord | null {
    const c = this.charges.get(id);
    return c && c.tenantId === tenantId ? { ...c } : null;
  }

  chargeTypeByCode(tenantId: string, code: string): ChargeTypeRecord | null {
    for (const c of this.charges.values()) {
      if (c.tenantId === tenantId && c.code === code) return { ...c };
    }
    return null;
  }

  listChargeTypes(tenantId: string): ChargeTypeRecord[] {
    return [...this.charges.values()].filter((c) => c.tenantId === tenantId).map((c) => ({ ...c }));
  }

  /** Resolve a charge code to its GL account + receiving entity, for invoice building. */
  resolve(tenantId: string, chargeCode: string): { glAccount: string; receivingEntityId: string } {
    const c = this.chargeTypeByCode(tenantId, chargeCode);
    if (!c) throw new EntityError(`unknown charge code '${chargeCode}' in tenant ${tenantId}`);
    return { glAccount: c.glAccount, receivingEntityId: c.receivingEntityId };
  }
}
