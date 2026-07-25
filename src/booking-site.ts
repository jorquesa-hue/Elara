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
import { RENT_PERIODS, RENT_PERIOD_LABEL, isRentPeriod, type SiteContent, type UnitSiteDetails, type RentPeriod } from './site-content.ts';
export { RENT_PERIODS, RENT_PERIOD_LABEL, isRentPeriod, type RentPeriod };
import { resolveTheme, type ResolvedTheme } from './site-templates.ts';

export interface SiteUnit { id: string; label: string; active: boolean; typeId?: string }
export interface SiteHold { unitId: string; start: string; end: string; status: string }
export interface SiteAgreementRate { unitId: string; rateCents: number; start: string; period?: RentPeriod }

/** A floorplan/unit type — multifamily portfolios merchandise these, not the
 *  individual doors. Marketing details live once on the type. */
export interface SiteUnitType {
  id: string; code: string; name: string;
  bedrooms?: number; bathrooms?: number; maxGuests?: number; areaSqm?: number;
  baseRentCents?: number; description?: string;
  /** The period baseRentCents is quoted in (default month for a floorplan). */
  rentPeriod?: RentPeriod;
}

/** One floorplan section on the public site: its details, how many published
 *  units it has, and the lowest advertised price across them. */
export interface SiteFloorplan extends SiteUnitType {
  unitCount: number;
  fromCents: number | null;
}

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
  /** The tenant's floorplans/unit types, if it merchandises by type. */
  unitTypes?: readonly SiteUnitType[];
}

/** One community on the portfolio directory/landing page — a card linking to its
 *  own property site (its custom domain if it has one, else /site/:tenant/p/:code). */
export interface SiteCommunity {
  code: string;
  name: string;
  unitCount: number;
  fromCents: number | null;
  cover?: string;
  subtitle?: string;
  domain?: string;
}

export interface SiteListing {
  tenantId: string;
  displayName: string;
  currency: string;
  brand: SiteBrand;
  /** Portfolio directory of community sites (portfolio scope only, ≥1 community). */
  directory?: SiteCommunity[];
  content: Omit<SiteContent, 'units'>;
  /** The picked template + adjustments + brand accent, flattened for the page. */
  theme: ResolvedTheme;
  /** Set only when ?template= previews a design other than the saved one. */
  previewTemplate?: string;
  /** True when the listing is representative sample data (design preview only). */
  sampleData?: boolean;
  /** True when a photo-less design preview borrowed stock photography. */
  samplePhotos?: boolean;
  units: Array<{ id: string; label: string; fromCents: number | null; pricePeriod?: RentPeriod; typeId?: string; details?: UnitSiteDetails }>;
  /** Floorplan sections (only types with ≥1 published unit), largest first. */
  floorplans: SiteFloorplan[];
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

/** The base rate to advertise for a unit, in precedence order: its most recent
 *  agreement rate (real per-unit signal), else its floorplan's market rent
 *  (authored per type — beats the generic pricing rule so a nightly dynamic
 *  rule can't mask a multifamily monthly asking rent), else the tenant rule's
 *  base, else null ("contact for rates"). */
/** The advertised "from" price AND the period it is quoted in. The period always
 *  follows the SOURCE of the number — an agreement's rate is per its kind, a
 *  floorplan's market rent is per the floorplan's own period, a dynamic pricing
 *  rule is nightly — so the label can never contradict the figure. */
function unitBaseRate(unitId: string, inp: BookingSiteInput, type?: SiteUnitType): { cents: number; period: RentPeriod } | null {
  // An explicit site-level period wins: the operator has told us how they quote,
  // and entered their rents in that period. Otherwise infer from the source of
  // the figure, so the label can never contradict it.
  const declared = inp.content?.rentPeriod;
  const forUnit = inp.agreements.filter((a) => a.unitId === unitId).sort((a, b) => (a.start < b.start ? 1 : -1));
  const live = forUnit[0];
  if (live && live.rateCents > 0) return { cents: live.rateCents, period: declared ?? live.period ?? 'night' };
  if (type?.baseRentCents && type.baseRentCents > 0) return { cents: type.baseRentCents, period: declared ?? type.rentPeriod ?? 'month' };
  if (inp.rule && inp.rule.baseCents > 0) return { cents: inp.rule.baseCents, period: declared ?? 'night' };
  return null;
}
function unitBaseCents(unitId: string, inp: BookingSiteInput, typeRentCents?: number): number | null {
  const forUnit = inp.agreements.filter((a) => a.unitId === unitId).sort((a, b) => (a.start < b.start ? 1 : -1));
  if (forUnit.length && forUnit[0]!.rateCents > 0) return forUnit[0]!.rateCents;
  if (typeRentCents && typeRentCents > 0) return typeRentCents;
  if (inp.rule && inp.rule.baseCents > 0) return inp.rule.baseCents;
  return null;
}

/** A unit is on the site when it is active AND not explicitly unpublished. */
function isPublished(u: SiteUnit, inp: BookingSiteInput): boolean {
  return u.active && inp.content?.units?.[u.id]?.published !== false;
}

/** The marketing listing: every published unit with a "from" price + its
 *  operator-authored details, plus the page content (hero/about/contact). */
/** Curated free-license (Unsplash) real-estate photography, used ONLY to dress a
 *  DESIGN PREVIEW. A design cannot be judged against grey gradients — the sales
 *  team needs to see the template the way a finished site looks — but the kernel
 *  never fetches image bytes: these are CDN URLs the VIEWER's browser loads.
 *  An operator's own photos always win; this only fills a preview that has none. */
export const STOCK_PHOTOS = {
  exterior: ['1512917774080-9991f1c4c750', '1568605114967-8130f3a36994', '1600596542815-ffad4c1539a9', '1545324418-cc1a3fa10c00', '1580587771525-78b9dba3b914', '1570129477492-45c003edd2be'],
  interior: ['1560448204-e02f11c3d0e2', '1502672260266-1c1ef2d93688', '1493809842364-78817add7ffb', '1484154218962-a197022b5858', '1600607687939-ce8a6c25118c', '1522708323590-d24dbb6b0267', '1586023492125-27b2c045efd7', '1616486338812-3dadae4b4ace'],
  scenic: ['1519501025264-65ba15a82390', '1600585154340-be6161a56a0c'],
} as const;

/** A CDN URL for one curated photo, sized for the web. */
export const stockPhotoUrl = (id: string, w = 1280): string =>
  `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=${w}&q=70`;

/** The pool a preview draws from, ordered so consecutive tiles look different. */
export function stockPhotoPool(): string[] {
  const { exterior, interior, scenic } = STOCK_PHOTOS;
  const out: string[] = [];
  const most = Math.max(exterior.length, interior.length, scenic.length);
  for (let i = 0; i < most; i++) {
    if (interior[i]) out.push(stockPhotoUrl(interior[i]!));
    if (exterior[i]) out.push(stockPhotoUrl(exterior[i]!));
    if (scenic[i]) out.push(stockPhotoUrl(scenic[i]!));
  }
  return out;
}

/** True when a listing carries no photography at all — hero, gallery or units. */
export function listingHasPhotos(l: SiteListing): boolean {
  if (l.content.heroPhotoDataUrl) return true;
  if ((l.content.galleryPhotos ?? []).length) return true;
  return l.units.some((u) => !!(u.details?.photoDataUrl || (u.details?.photos ?? []).length));
}

/** Dress a photo-less DESIGN PREVIEW with curated stock photography, in place.
 *  Content, prices and unit labels stay the operator's — only the imagery is
 *  borrowed, so the preview shows their portfolio in a finished-looking design.
 *  A no-op (returns false) the moment the listing has a photo of its own. */
export function dressWithStockPhotos(l: SiteListing): boolean {
  if (listingHasPhotos(l)) return false;
  const pool = stockPhotoPool();
  if (!pool.length) return false;
  const at = (i: number) => pool[((i % pool.length) + pool.length) % pool.length]!;
  l.content.heroPhotoDataUrl = stockPhotoUrl(STOCK_PHOTOS.scenic[1]!, 1800);
  l.content.galleryPhotos = [0, 3, 6, 1, 4, 7].map(at);
  l.units.forEach((u, i) => {
    const details = { ...(u.details ?? {}) };
    details.photoDataUrl = at(i * 3);
    details.photos = [at(i * 3 + 1), at(i * 3 + 2)];
    u.details = details;
  });
  return true;
}

export function siteListing(inp: BookingSiteInput): SiteListing {
  const { units: _unitDetails, ...page } = inp.content ?? {};
  const typeById = new Map((inp.unitTypes ?? []).map((t) => [t.id, t]));
  const units = inp.units
    .filter((u) => isPublished(u, inp))
    .map((u) => {
      // Unit-level authored details win; gaps inherit from the floorplan, so a
      // 200-unit building is merchandised by editing a handful of types.
      const own = inp.content?.units?.[u.id];
      const t = u.typeId ? typeById.get(u.typeId) : undefined;
      const inherited: UnitSiteDetails | undefined = t
        ? {
            ...(t.bedrooms !== undefined ? { bedrooms: t.bedrooms } : {}),
            ...(t.bathrooms !== undefined ? { bathrooms: t.bathrooms } : {}),
            ...(t.maxGuests !== undefined ? { maxGuests: t.maxGuests } : {}),
            ...(t.areaSqm !== undefined ? { areaSqm: t.areaSqm } : {}),
            ...(t.description !== undefined && !own?.description ? { description: t.description } : {}),
            ...own,
          }
        : own;
      const rate = unitBaseRate(u.id, inp, t);
      return {
        id: u.id,
        label: u.label,
        fromCents: rate ? rate.cents : null,
        ...(rate ? { pricePeriod: rate.period } : {}),
        ...(u.typeId ? { typeId: u.typeId } : {}),
        ...(inherited && Object.keys(inherited).length ? { details: inherited } : {}),
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
  // Fold published units into floorplan sections (types with no live units are skipped).
  const floorplans: SiteFloorplan[] = [...typeById.values()]
    .map((t) => {
      const inType = units.filter((u) => u.typeId === t.id);
      const prices = inType.map((u) => u.fromCents).filter((c): c is number => c != null);
      const period = inType.find((u) => u.pricePeriod)?.pricePeriod ?? t.rentPeriod ?? 'month';
      return { ...t, rentPeriod: period, unitCount: inType.length, fromCents: prices.length ? Math.min(...prices) : null };
    })
    .filter((f) => f.unitCount > 0)
    .sort((a, b) => b.unitCount - a.unitCount || a.name.localeCompare(b.name));
  return {
    tenantId: inp.tenantId,
    displayName: inp.displayName,
    currency: inp.currency,
    brand: inp.brand ?? {},
    content: page,
    theme: resolveTheme(page.template, page.templateOptions, inp.brand?.color),
    units,
    floorplans,
  };
}

/** SEO/social summary for a listing — used to inject <title>/<meta>/OpenGraph
 *  and JSON-LD into the served HTML so shared links and crawlers see real
 *  content (the page itself hydrates client-side). Pure. og:image prefers an
 *  https URL, since social scrapers don't embed data: URLs. */
export interface SiteSeo { title: string; description: string; image?: string }
export function siteSeo(listing: SiteListing): SiteSeo {
  const name = listing.displayName;
  const c = listing.content ?? {};
  const title = c.heroTitle ? `${c.heroTitle} · ${name}` : `${name} · Book your stay`;
  const firstSentence = (c.about ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const description =
    c.seoDescription ??
    (firstSentence ||
      `Browse ${listing.units.length} home${listing.units.length === 1 ? '' : 's'} at ${name} with live availability and instant pricing.`);
  const candidates: Array<string | undefined> = [
    c.heroPhotoDataUrl,
    ...(c.galleryPhotos ?? []),
    ...listing.units.flatMap((u) => [u.details?.photoDataUrl, ...(u.details?.photos ?? [])]),
  ];
  const image = candidates.find((u) => typeof u === 'string' && /^https:\/\//.test(u));
  return image ? { title, description, image } : { title, description };
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
  const typeById = new Map((inp.unitTypes ?? []).map((t) => [t.id, t]));
  return inp.units
    .filter((u) => isPublished(u, inp))
    .map((u) => {
      const held = inp.holds.some((h) => h.unitId === u.id && overlaps(h, from, to));
      const base = unitBaseCents(u.id, inp, u.typeId ? typeById.get(u.typeId)?.baseRentCents : undefined);
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
