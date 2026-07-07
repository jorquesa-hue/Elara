// Amenities: catalog of chargeable extras (cleaning, parking, breakfast…).
// Charging an amenity issues an invoice line against amenity revenue via the
// injected billing issuer, so all money still flows through one ledger.

export interface AmenityItem {
  sku: string;
  name: string;
  unitCents: number;
  currency: string;
}

export interface AmenityCharge {
  chargeId: string;
  sku: string;
  qty: number;
  amountCents: number;
  description: string;
}

export class AmenityError extends Error {}

export class AmenityCatalog {
  private items = new Map<string, AmenityItem>();

  add(item: AmenityItem): void {
    if (this.items.has(item.sku)) throw new AmenityError(`duplicate amenity sku: ${item.sku}`);
    if (!Number.isInteger(item.unitCents) || item.unitCents <= 0) {
      throw new AmenityError(`amenity ${item.sku}: unitCents must be a positive integer`);
    }
    this.items.set(item.sku, { ...item });
  }

  get(sku: string): AmenityItem {
    const item = this.items.get(sku);
    if (!item) throw new AmenityError(`unknown amenity: ${sku}`);
    return { ...item };
  }

  charge(sku: string, qty: number, chargeId: string): AmenityCharge {
    const item = this.get(sku);
    if (!Number.isInteger(qty) || qty <= 0) {
      throw new AmenityError(`amenity ${sku}: qty must be a positive integer`);
    }
    return {
      chargeId,
      sku,
      qty,
      amountCents: item.unitCents * qty,
      description: `${item.name} x${qty}`,
    };
  }
}
