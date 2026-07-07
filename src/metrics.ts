// Metrics: hospitality KPIs derived from calendar holds and the ledger.
// Occupancy, ADR (average daily rate), RevPAR (revenue per available room).
// Pure projections over existing state.

import type { Calendar } from './agreement.ts';
import type { Ledger } from './ledger.ts';

function nightsBetween(start: string, end: string): number {
  const ms = Date.parse(end) - Date.parse(start);
  return Math.max(0, Math.round(ms / 86_400_000));
}

export interface OccupancyReport {
  unitCount: number;
  windowNights: number;
  availableRoomNights: number;
  soldRoomNights: number;
  occupancy: number; // 0..1
}

/** Occupancy across a window for a known set of units. */
export function occupancy(
  calendar: Calendar,
  unitIds: readonly string[],
  windowStart: string,
  windowEnd: string,
): OccupancyReport {
  const windowNights = nightsBetween(windowStart, windowEnd);
  const availableRoomNights = unitIds.length * windowNights;
  let soldRoomNights = 0;
  for (const unitId of unitIds) {
    for (const h of calendar.holdsFor(unitId)) {
      if (h.status !== 'active') continue;
      const s = h.start > windowStart ? h.start : windowStart;
      const e = h.end < windowEnd ? h.end : windowEnd;
      soldRoomNights += nightsBetween(s, e);
    }
  }
  return {
    unitCount: unitIds.length,
    windowNights,
    availableRoomNights,
    soldRoomNights,
    occupancy: availableRoomNights > 0 ? soldRoomNights / availableRoomNights : 0,
  };
}

export interface RevenueMetrics {
  roomRevenueCents: number;
  soldRoomNights: number;
  availableRoomNights: number;
  adrCents: number; // room revenue / sold nights
  revparCents: number; // room revenue / available nights
}

export function revenueMetrics(
  ledger: Ledger,
  occ: OccupancyReport,
): RevenueMetrics {
  const roomRevenueCents = ledger.linesFor({ account: 'revenue:room' }).reduce(
    (s, l) => s + l.creditCents - l.debitCents,
    0,
  );
  return {
    roomRevenueCents,
    soldRoomNights: occ.soldRoomNights,
    availableRoomNights: occ.availableRoomNights,
    adrCents: occ.soldRoomNights > 0 ? Math.round(roomRevenueCents / occ.soldRoomNights) : 0,
    revparCents:
      occ.availableRoomNights > 0 ? Math.round(roomRevenueCents / occ.availableRoomNights) : 0,
  };
}
