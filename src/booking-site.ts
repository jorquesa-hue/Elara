// Integrated booking website — the guest-facing storefront over the SAME live
// inventory the operator manages. A PURE, zero-dep engine: given a tenant's
// units, their calendar holds, past agreements (for a per-unit base rate) and the
// dynamic-pricing rule, it produces (a) a marketing LISTING (each bookable unit
// with a "from" nightly price) and (b) a live AVAILABILITY check for a date range
// (which units are free, each with a dynamic-pricing quote). A booking request
// becomes a CRM lead in the operator's pipeline — no payment is taken here (v1),
// so nothing money-moving happens on the public surface.
//
// This is the read-only public projection of the portfolio: it exposes unit
// labels, prices and availability (marketing data) — never residents, ledgers or
// any PII.

import { computeQuote, type PricingRule } from './revenue.ts';
import type { SiteContent, UnitSiteDetails } from './site-content.ts';
import { resolveTheme, type ResolvedTheme } from './site-templates.ts';

export interface SiteUnit { id: string; label: string; active: boolean }
export interface SiteHold { unitId: string; start: string; end: string; status: string }
export interface SiteAgreementRate { unitId: string; rateCents: number; start: string }

export interface SiteBrand { color?: string; logoDataUrl?: string; tagline?: string; locale?: string }

export interface BookingSiteInput {
  tenantId: string;
  displayName: string;
  currency: string;
  units: readonly SiteUnit[];
  holds: readonly SiteHold[];
  agreements: readonly SiteAgreementRate[]; // used only to derive a per-unit base rate
  rule?: PricingRule; // the tenant's primary dynamic-pricing rule, if any
  brand?: SiteBrand;
  /** Operator-authored page content + per-unit marketing details. */
  content?: SiteContent;
}

export interface SiteListing {
  tenantId: string;
  displayName: string;
  currency: string;
  brand: SiteBrand;
  content: Omit<SiteContent, 'units'>;
  /** The picked template + adjustments + brand accent, flattened for the page. */
  theme: ResolvedTheme;
  units: Array<{ id: string; label: string; fromCents: number | null; details?: UnitSiteDetails }>;
}

export interface AvailabilityUnit {
  unitId: string;
  label: string;
  available: boolean;
  nights: number;
  nightlyCents: number | null;
  totalCents: number | null;
  factors?: Array<{ name: string; factorBps: number }>;
}

const DAY = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ms = (d: string) => Date.parse(d.length > 10 ? d : `${d}T00:00:00Z`);

export function isValidDate(d: unknown): d is string {
  if (typeof d !== 'string' || !ISO_DATE.test(d)) return false;
  const t = Date.parse(`${d}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d;
}

/** The base nightly rate to advertise for a unit: its most recent agreement's
 *  rate, else the tenant rule's base, else null ("contact for rates"). */
function unitBaseCents(unitId: string, inp: BookingSiteInput): number | null {
  const forUnit = inp.agreements.filter((a) => a.unitId === unitId).sort((a, b) => (a.start < b.start ? 1 : -1));
  if (forUnit.length && forUnit[0]!.rateCents > 0) return forUnit[0]!.rateCents;
  if (inp.rule && inp.rule.baseCents > 0) return inp.rule.baseCents;
  return null;
}

/** A unit is on the site when it is active AND not explicitly unpublished. */
function isPublished(u: SiteUnit, inp: BookingSiteInput): boolean {
  return u.active && inp.content?.units?.[u.id]?.published !== false;
}

/** The marketing listing: every published unit with a "from" price + its
 *  operator-authored details, plus the page content (hero/about/contact). */
export function siteListing(inp: BookingSiteInput): SiteListing {
  const { units: _unitDetails, ...page } = inp.content ?? {};
  return {
    tenantId: inp.tenantId,
    displayName: inp.displayName,
    currency: inp.currency,
    brand: inp.brand ?? {},
    content: page,
    theme: resolveTheme(page.template, page.templateOptions, inp.brand?.color),
    units: inp.units
      .filter((u) => isPublished(u, inp))
      .map((u) => {
        const details = inp.content?.units?.[u.id];
        return { id: u.id, label: u.label, fromCents: unitBaseCents(u.id, inp), ...(details ? { details } : {}) };
      })
      .sort((a, b) => a.label.localeCompare(b.label)),
  };
}

function overlaps(hold: SiteHold, from: string, to: string): boolean {
  return hold.status === 'active' && ms(hold.start) < ms(to) && ms(from) < ms(hold.end);
}

/**
 * Live availability for [from, to): each active unit with whether it's free and,
 * when it is, a dynamic-pricing quote (per-unit base run through the tenant rule).
 * Throws on invalid/reversed dates so the caller can 400.
 */
export function checkAvailability(inp: BookingSiteInput, from: string, to: string): AvailabilityUnit[] {
  if (!isValidDate(from) || !isValidDate(to)) throw new Error('from and to must be YYYY-MM-DD dates');
  const nights = Math.round((ms(to) - ms(from)) / DAY);
  if (nights <= 0) throw new Error('to must be after from');
  return inp.units
    .filter((u) => isPublished(u, inp))
    .map((u) => {
      const held = inp.holds.some((h) => h.unitId === u.id && overlaps(h, from, to));
      const base = unitBaseCents(u.id, inp);
      let nightlyCents: number | null = null;
      let totalCents: number | null = null;
      let factors: AvailabilityUnit['factors'];
      if (!held && base != null) {
        if (inp.rule) {
          const q = computeQuote({ ...inp.rule, baseCents: base }, { checkIn: from, nights });
          nightlyCents = q.nightlyCents; totalCents = q.totalCents; factors = q.factors;
        } else {
          nightlyCents = base; totalCents = base * nights;
        }
      }
      return { unitId: u.id, label: u.label, available: !held, nights, nightlyCents, totalCents, ...(factors ? { factors } : {}) };
    })
    .sort((a, b) => Number(b.available) - Number(a.available) || a.label.localeCompare(b.label));
}
