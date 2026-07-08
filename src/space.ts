// Space — a self-referencing tree from property down to a single bed, plus
// bookable common areas and amenities. Generalises the flat unit so a lease can
// attach at unit, room, or bed level (#9) and the calendar's no-double-booking
// guard covers every leasable or bookable space uniformly (#6). Depth is a
// per-property choice: a whole-unit operator stops at `unit`; student housing
// goes down to `bed`.

export type SpaceType =
  | 'property' | 'building' | 'floor' | 'unit' | 'room' | 'bed' | 'common' | 'amenity';

export const SPACE_TYPES: readonly SpaceType[] = [
  'property', 'building', 'floor', 'unit', 'room', 'bed', 'common', 'amenity',
];

export interface SpaceRecord {
  id: string;
  tenantId: string;
  parentId?: string;
  type: SpaceType;
  code: string; // external/reporting key, unique per tenant
  label: string;
  leasable: boolean; // a lease may attach here (unit/room/bed); false for common/amenity
  capacity?: number;
  attributes?: Record<string, unknown>; // sqm, features, lock id, etc.
}

export class SpaceError extends Error {}

export class SpaceTree {
  private byId = new Map<string, SpaceRecord>();

  add(rec: SpaceRecord): SpaceRecord {
    if (this.byId.has(rec.id)) throw new SpaceError(`duplicate space: ${rec.id}`);
    if (!SPACE_TYPES.includes(rec.type)) throw new SpaceError(`space ${rec.id}: unknown type ${rec.type}`);
    if (rec.parentId) {
      const parent = this.byId.get(rec.parentId);
      if (!parent) throw new SpaceError(`space ${rec.id}: parent ${rec.parentId} not found`);
      if (parent.tenantId !== rec.tenantId) throw new SpaceError(`space ${rec.id}: parent belongs to another tenant`);
    }
    for (const s of this.byId.values()) {
      if (s.tenantId === rec.tenantId && s.code === rec.code) {
        throw new SpaceError(`space code '${rec.code}' already used in tenant ${rec.tenantId}`);
      }
    }
    this.byId.set(rec.id, { ...rec });
    return { ...rec };
  }

  get(tenantId: string, id: string): SpaceRecord | null {
    const s = this.byId.get(id);
    return s && s.tenantId === tenantId ? { ...s } : null;
  }

  children(id: string): SpaceRecord[] {
    return [...this.byId.values()].filter((s) => s.parentId === id).map((s) => ({ ...s }));
  }

  /** Nearest-first ancestors up to the root. */
  ancestors(id: string): SpaceRecord[] {
    const out: SpaceRecord[] = [];
    let cur = this.byId.get(id);
    const seen = new Set<string>([id]);
    while (cur?.parentId) {
      const p = this.byId.get(cur.parentId);
      if (!p || seen.has(p.id)) break; // guard against cycles
      seen.add(p.id);
      out.push({ ...p });
      cur = p;
    }
    return out;
  }

  descendants(id: string): SpaceRecord[] {
    const out: SpaceRecord[] = [];
    const stack = [...this.children(id)];
    while (stack.length) {
      const s = stack.pop()!;
      out.push(s);
      stack.push(...this.children(s.id));
    }
    return out;
  }

  /** Human-readable code path from root to this space, e.g. "VM42 / A / A-304". */
  path(tenantId: string, id: string): string {
    const self = this.get(tenantId, id);
    if (!self) return '';
    const chain = [...this.ancestors(id)].reverse();
    return [...chain, self].map((s) => s.code).join(' / ');
  }

  leasable(tenantId: string): SpaceRecord[] {
    return [...this.byId.values()].filter((s) => s.tenantId === tenantId && s.leasable).map((s) => ({ ...s }));
  }

  list(tenantId: string): SpaceRecord[] {
    return [...this.byId.values()].filter((s) => s.tenantId === tenantId).map((s) => ({ ...s }));
  }
}
