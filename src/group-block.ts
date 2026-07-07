// Group blocks: a set of held units for a corporate/event contract, picked up
// into individual agreements over time. The block places calendar holds up
// front (so inventory is real — invariant 4); pickup releases a block hold and
// hands its window to a freshly created agreement, preserving no-double-book.

import { Calendar, type CalendarHold } from './agreement.ts';

export interface GroupBlock {
  id: string;
  tenantId: string;
  accountName: string;
  start: string;
  end: string;
  holdIds: string[];
  pickedUp: string[]; // hold ids converted to agreements
}

export class GroupBlockError extends Error {}

export class GroupBlocks {
  private blocks = new Map<string, GroupBlock>();

  constructor(private readonly calendar: Calendar) {}

  create(input: {
    id: string;
    tenantId: string;
    accountName: string;
    start: string;
    end: string;
    unitIds: string[];
  }): GroupBlock {
    if (this.blocks.has(input.id)) throw new GroupBlockError(`duplicate group block: ${input.id}`);
    const holdIds: string[] = [];
    input.unitIds.forEach((unitId, i) => {
      const holdId = `${input.id}-hold-${i}`;
      // Delegates to Calendar, which enforces no overlap (double-inventory).
      this.calendar.hold({
        id: holdId,
        unitId,
        holderId: input.id,
        start: input.start,
        end: input.end,
      });
      holdIds.push(holdId);
    });
    const block: GroupBlock = {
      id: input.id,
      tenantId: input.tenantId,
      accountName: input.accountName,
      start: input.start,
      end: input.end,
      holdIds,
      pickedUp: [],
    };
    this.blocks.set(block.id, block);
    return this.get(block.id);
  }

  /**
   * Pick up one held unit into an agreement. Releases the block hold and
   * re-holds the same window under the agreement id, so the unit is never
   * momentarily double-booked nor momentarily free.
   */
  pickup(blockId: string, holdId: string, agreementId: string): CalendarHold {
    const block = this.blocks.get(blockId);
    if (!block) throw new GroupBlockError(`unknown group block: ${blockId}`);
    if (!block.holdIds.includes(holdId)) {
      throw new GroupBlockError(`hold ${holdId} is not part of block ${blockId}`);
    }
    if (block.pickedUp.includes(holdId)) {
      throw new GroupBlockError(`hold ${holdId} already picked up`);
    }
    const original = this.calendar
      .activeHolds()
      .find((h) => h.id === holdId);
    if (!original) throw new GroupBlockError(`block hold ${holdId} is not active`);

    this.calendar.release(holdId);
    const agHold = this.calendar.hold({
      id: `${agreementId}-hold`,
      unitId: original.unitId,
      holderId: agreementId,
      start: original.start,
      end: original.end,
    });
    block.pickedUp.push(holdId);
    return agHold;
  }

  get(id: string): GroupBlock {
    const b = this.blocks.get(id);
    if (!b) throw new GroupBlockError(`unknown group block: ${id}`);
    return { ...b, holdIds: [...b.holdIds], pickedUp: [...b.pickedUp] };
  }
}
