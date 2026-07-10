// Maintenance — work orders over the space tree. A work order is raised against
// a space (where), optionally by a requester party and assigned to a vendor
// party; its cost, when external, is recorded as an accounts-payable bill to
// that vendor (reusing Payables — no bespoke money path). The lifecycle is a
// small validated state machine; like invoice/deposit it is a mutable-status
// record (not one of the three append-only streams), with timestamps captured
// at each transition for the audit trail.

export type WorkOrderStatus = 'open' | 'assigned' | 'in_progress' | 'completed' | 'cancelled';
export type WorkOrderPriority = 'low' | 'normal' | 'high' | 'urgent';

export const WORK_ORDER_PRIORITIES: readonly WorkOrderPriority[] = ['low', 'normal', 'high', 'urgent'];

export interface WorkOrderRecord {
  id: string;
  tenantId: string;
  spaceId?: string; // where — a leasable or common space
  title: string;
  description?: string;
  category?: string; // plumbing, electrical, appliance, cleaning, …
  priority: WorkOrderPriority;
  status: WorkOrderStatus;
  requestedByPartyId?: string;
  assignedVendorPartyId?: string;
  billId?: string; // the AP bill raised for the repair cost, if any
  openedAt: string;
  assignedAt?: string;
  startedAt?: string;
  closedAt?: string;
  resolution?: string;
  cancelReason?: string;
}

export class MaintenanceError extends Error {}

export class WorkOrders {
  private orders = new Map<string, WorkOrderRecord>();

  /** Load stored work orders for cold-start rehydration. */
  hydrate(records: readonly WorkOrderRecord[]): void {
    for (const r of records) this.orders.set(r.id, { ...r });
  }

  open(input: {
    id: string;
    tenantId: string;
    title: string;
    openedAt: string;
    spaceId?: string;
    description?: string;
    category?: string;
    priority?: WorkOrderPriority;
    requestedByPartyId?: string;
  }): WorkOrderRecord {
    if (this.orders.has(input.id)) throw new MaintenanceError(`duplicate work order: ${input.id}`);
    if (!input.title) throw new MaintenanceError(`work order ${input.id}: title is required`);
    const priority = input.priority ?? 'normal';
    if (!WORK_ORDER_PRIORITIES.includes(priority)) throw new MaintenanceError(`unknown priority: ${priority}`);
    const wo: WorkOrderRecord = {
      id: input.id,
      tenantId: input.tenantId,
      spaceId: input.spaceId,
      title: input.title,
      description: input.description,
      category: input.category,
      priority,
      status: 'open',
      requestedByPartyId: input.requestedByPartyId,
      openedAt: input.openedAt,
    };
    this.orders.set(wo.id, wo);
    return { ...wo };
  }

  get(id: string): WorkOrderRecord {
    const wo = this.orders.get(id);
    if (!wo) throw new MaintenanceError(`unknown work order: ${id}`);
    return { ...wo };
  }

  private mutate(id: string, from: WorkOrderStatus[], fn: (wo: WorkOrderRecord) => void): WorkOrderRecord {
    const wo = this.orders.get(id);
    if (!wo) throw new MaintenanceError(`unknown work order: ${id}`);
    if (!from.includes(wo.status)) {
      throw new MaintenanceError(`work order ${id} is ${wo.status}; expected one of ${from.join('/')}`);
    }
    fn(wo);
    return { ...wo };
  }

  /** Assign a vendor party; open → assigned. */
  assign(id: string, vendorPartyId: string, at: string): WorkOrderRecord {
    return this.mutate(id, ['open', 'assigned'], (wo) => {
      wo.assignedVendorPartyId = vendorPartyId;
      wo.status = 'assigned';
      wo.assignedAt = at;
    });
  }

  /** Work begins; open/assigned → in_progress. */
  start(id: string, at: string): WorkOrderRecord {
    return this.mutate(id, ['open', 'assigned'], (wo) => {
      wo.status = 'in_progress';
      wo.startedAt = at;
    });
  }

  /** Close as done; any active status → completed. Optionally link the AP bill. */
  complete(id: string, at: string, opts: { resolution?: string; billId?: string } = {}): WorkOrderRecord {
    return this.mutate(id, ['open', 'assigned', 'in_progress'], (wo) => {
      wo.status = 'completed';
      wo.closedAt = at;
      if (opts.resolution) wo.resolution = opts.resolution;
      if (opts.billId) wo.billId = opts.billId;
    });
  }

  /** Abandon; any non-terminal status → cancelled. */
  cancel(id: string, at: string, reason: string): WorkOrderRecord {
    return this.mutate(id, ['open', 'assigned', 'in_progress'], (wo) => {
      wo.status = 'cancelled';
      wo.closedAt = at;
      wo.cancelReason = reason;
    });
  }

  /** Link an AP bill to a work order after the fact (e.g. billed on completion). */
  attachBill(id: string, billId: string): WorkOrderRecord {
    const wo = this.orders.get(id);
    if (!wo) throw new MaintenanceError(`unknown work order: ${id}`);
    wo.billId = billId;
    return { ...wo };
  }

  list(tenantId: string, filter: { status?: WorkOrderStatus; spaceId?: string } = {}): WorkOrderRecord[] {
    return [...this.orders.values()]
      .filter(
        (wo) =>
          wo.tenantId === tenantId &&
          (filter.status === undefined || wo.status === filter.status) &&
          (filter.spaceId === undefined || wo.spaceId === filter.spaceId),
      )
      .map((wo) => ({ ...wo }));
  }

  all(): readonly WorkOrderRecord[] {
    return [...this.orders.values()].map((wo) => ({ ...wo }));
  }
}
