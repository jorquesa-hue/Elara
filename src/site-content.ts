// Website content — the operator-editable substance of the integrated booking
// site. Branding (logo/color/tagline) lives on TenantConfig; THIS module owns the
// page itself: hero copy, an about section, contact/social links, and per-unit
// marketing details (headline, description, beds/baths/guests, amenities, photo,
// and a publish switch). Pure + zero-dep: sanitizeSiteContent validates and
// normalizes operator input; SiteContentStore is tenant-scoped storage that the
// App snapshots into the tenant row (site_content jsonb) so the site survives a
// restart. Only marketing data lives here — never residents, money, or PII.

export interface UnitSiteDetails {
  /** Shown on the site? Defaults to true for active units. */
  published?: boolean;
  headline?: string;
  description?: string;
  bedrooms?: number;
  bathrooms?: number;
  maxGuests?: number;
  areaSqm?: number;
  amenities?: string[];
  /** Cover photo — data:image/* base64 (≤256 KB) or an https URL. */
  photoDataUrl?: string;
  /** Extra gallery photos (https URLs — kept out of the base64 payload). */
  photos?: string[];
}

/** A question/answer pair for the FAQ section. */
export interface SiteFaq { q: string; a: string }
/** A "good to know" fact — check-in time, pet policy, cancellation, etc. */
export interface SitePolicy { label: string; value: string }
/** A guest testimonial/review. */
export interface SiteTestimonial { quote: string; name: string; location?: string }
/** Where the properties are, for a Location section + directions link. */
export interface SiteLocation { address?: string; neighborhood?: string; mapsQuery?: string }

export interface SiteContent {
  heroTitle?: string;
  /** A short line under the hero title. */
  heroSubtitle?: string;
  about?: string;
  contactEmail?: string;
  contactPhone?: string;
  whatsapp?: string;
  instagram?: string;
  facebook?: string;
  /** Which of the 20 site templates to render (default: 'classic'). */
  template?: string;
  /** Per-template adjustments — corners, font, hero layout, card layout. */
  templateOptions?: TemplateOptions;
  /** A hero background photo for banner/split heroes (data:image ≤256 KB or https). */
  heroPhotoDataUrl?: string;
  /** Portfolio-wide photo gallery (https URLs). */
  galleryPhotos?: string[];
  /** Building/community amenities & selling points (chips). */
  highlights?: string[];
  /** Where the properties are — powers the Location section + a directions link. */
  location?: SiteLocation;
  /** Frequently-asked questions (accordion). */
  faqs?: SiteFaq[];
  /** "Good to know" facts — check-in/out, pets, smoking, cancellation. */
  policies?: SitePolicy[];
  /** Guest testimonials / reviews. */
  testimonials?: SiteTestimonial[];
  /** Overrides the SEO meta description (else derived from about/hero). */
  seoDescription?: string;
  units?: Record<string, UnitSiteDetails>;
}

import { isKnownTemplate, FONT_KEYS, RADIUS_KEYS, HERO_STYLES, CARD_STYLES, type TemplateOptions, type FontKey, type RadiusKey, type HeroStyle, type CardStyle } from './site-templates.ts';

export class SiteContentError extends Error {}

const MAX_TEXT = 4000;
const MAX_LINE = 200;
const MAX_AMENITIES = 24;

function str(v: unknown, max = MAX_LINE): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return s ? s.slice(0, max) : undefined;
}
function num(v: unknown, lo: number, hi: number): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return undefined;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

/** A list of trimmed, non-empty, capped strings. */
function strList(v: unknown, cap: number, max = MAX_LINE): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.map((x) => str(x, max)).filter((x): x is string => !!x).slice(0, cap);
  return out.length ? out : undefined;
}

/** A list of validated photo URLs (throws on a malformed one). */
function photoList(v: unknown, cap: number): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v
    .map((x) => str(x, 300 * 1024))
    .filter((x): x is string => !!x)
    .slice(0, cap)
    .map((x) => assertSitePhoto(x));
  return out.length ? out : undefined;
}

export function assertSitePhoto(url: string): string {
  if (!/^data:image\/(png|jpeg|jpg|svg\+xml|webp|gif);base64,/.test(url) && !/^https:\/\//.test(url)) {
    throw new SiteContentError('photo must be an https URL or a data:image/* base64 URL');
  }
  if (url.length > 256 * 1024) throw new SiteContentError('photo is too large (max ~256 KB)');
  return url;
}

/** Validate + normalize operator input into a clean SiteContent. Throws on a bad
 *  photo (never silently stores junk); everything else is coerced or dropped. */
export function sanitizeSiteContent(input: unknown): SiteContent {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const out: SiteContent = {};
  const heroTitle = str(raw['heroTitle']); if (heroTitle) out.heroTitle = heroTitle;
  const heroSubtitle = str(raw['heroSubtitle'], 300); if (heroSubtitle) out.heroSubtitle = heroSubtitle;
  const about = str(raw['about'], MAX_TEXT); if (about) out.about = about;
  const seoDescription = str(raw['seoDescription'], 320); if (seoDescription) out.seoDescription = seoDescription;
  for (const k of ['contactEmail', 'contactPhone', 'whatsapp', 'instagram', 'facebook'] as const) {
    const v = str(raw[k]); if (v) out[k] = v;
  }
  // --- rich page sections (all optional) ----------------------------------
  const gallery = photoList(raw['galleryPhotos'], 12); if (gallery) out.galleryPhotos = gallery;
  const highlights = strList(raw['highlights'], 30, 80); if (highlights) out.highlights = highlights;
  const locRaw = raw['location'];
  if (locRaw && typeof locRaw === 'object') {
    const l = locRaw as Record<string, unknown>;
    const loc: SiteLocation = {};
    const address = str(l['address'], 300); if (address) loc.address = address;
    const neighborhood = str(l['neighborhood'], MAX_TEXT); if (neighborhood) loc.neighborhood = neighborhood;
    const mapsQuery = str(l['mapsQuery'], 300); if (mapsQuery) loc.mapsQuery = mapsQuery;
    if (Object.keys(loc).length) out.location = loc;
  }
  if (Array.isArray(raw['faqs'])) {
    const faqs: SiteFaq[] = [];
    for (const fRaw of raw['faqs'] as unknown[]) {
      if (!fRaw || typeof fRaw !== 'object') continue;
      const f = fRaw as Record<string, unknown>;
      const q = str(f['q'], 300);
      const a = str(f['a'], MAX_TEXT);
      if (q && a) faqs.push({ q, a });
      if (faqs.length >= 12) break;
    }
    if (faqs.length) out.faqs = faqs;
  }
  if (Array.isArray(raw['policies'])) {
    const policies: SitePolicy[] = [];
    for (const pRaw of raw['policies'] as unknown[]) {
      if (!pRaw || typeof pRaw !== 'object') continue;
      const p = pRaw as Record<string, unknown>;
      const label = str(p['label'], 80);
      const value = str(p['value'], 300);
      if (label && value) policies.push({ label, value });
      if (policies.length >= 12) break;
    }
    if (policies.length) out.policies = policies;
  }
  if (Array.isArray(raw['testimonials'])) {
    const testimonials: SiteTestimonial[] = [];
    for (const tRaw of raw['testimonials'] as unknown[]) {
      if (!tRaw || typeof tRaw !== 'object') continue;
      const t = tRaw as Record<string, unknown>;
      const quote = str(t['quote'], 600);
      const name = str(t['name'], 80);
      if (!quote || !name) continue;
      const location = str(t['location'], 80);
      testimonials.push(location ? { quote, name, location } : { quote, name });
      if (testimonials.length >= 12) break;
    }
    if (testimonials.length) out.testimonials = testimonials;
  }
  // Template + adjustments: unknown ids/values are dropped, never stored.
  const template = str(raw['template'], 40);
  if (template && isKnownTemplate(template)) out.template = template;
  const optsRaw = raw['templateOptions'];
  if (optsRaw && typeof optsRaw === 'object') {
    const o = optsRaw as Record<string, unknown>;
    const opts: TemplateOptions = {};
    if (typeof o['radius'] === 'string' && RADIUS_KEYS.includes(o['radius'] as RadiusKey)) opts.radius = o['radius'] as RadiusKey;
    if (typeof o['font'] === 'string' && FONT_KEYS.includes(o['font'] as FontKey)) opts.font = o['font'] as FontKey;
    if (typeof o['hero'] === 'string' && HERO_STYLES.includes(o['hero'] as HeroStyle)) opts.hero = o['hero'] as HeroStyle;
    if (typeof o['cards'] === 'string' && CARD_STYLES.includes(o['cards'] as CardStyle)) opts.cards = o['cards'] as CardStyle;
    if (Object.keys(opts).length) out.templateOptions = opts;
  }
  const heroPhoto = str(raw['heroPhotoDataUrl'], 300 * 1024);
  if (heroPhoto) out.heroPhotoDataUrl = assertSitePhoto(heroPhoto);
  const unitsRaw = raw['units'];
  if (unitsRaw && typeof unitsRaw === 'object') {
    const units: Record<string, UnitSiteDetails> = {};
    for (const [unitId, dRaw] of Object.entries(unitsRaw as Record<string, unknown>)) {
      if (!dRaw || typeof dRaw !== 'object') continue;
      const d = dRaw as Record<string, unknown>;
      const det: UnitSiteDetails = {};
      if (typeof d['published'] === 'boolean') det.published = d['published'] as boolean;
      const headline = str(d['headline']); if (headline) det.headline = headline;
      const description = str(d['description'], MAX_TEXT); if (description) det.description = description;
      const bedrooms = num(d['bedrooms'], 0, 50); if (bedrooms !== undefined) det.bedrooms = bedrooms;
      const bathrooms = num(d['bathrooms'], 0, 50); if (bathrooms !== undefined) det.bathrooms = bathrooms;
      const maxGuests = num(d['maxGuests'], 1, 100); if (maxGuests !== undefined) det.maxGuests = maxGuests;
      const areaSqm = num(d['areaSqm'], 0, 100000); if (areaSqm !== undefined) det.areaSqm = areaSqm;
      if (Array.isArray(d['amenities'])) {
        const am = (d['amenities'] as unknown[]).map((a) => str(a, 60)).filter((a): a is string => !!a).slice(0, MAX_AMENITIES);
        if (am.length) det.amenities = am;
      }
      const photo = str(d['photoDataUrl'], 300 * 1024);
      if (photo) det.photoDataUrl = assertSitePhoto(photo);
      const photos = photoList(d['photos'], 8); if (photos) det.photos = photos;
      if (Object.keys(det).length) units[unitId] = det;
    }
    if (Object.keys(units).length) out.units = units;
  }
  return out;
}

/** Tenant-scoped site content. get() always returns a (possibly empty) object. */
export class SiteContentStore {
  private byTenant = new Map<string, SiteContent>();

  get(tenantId: string): SiteContent {
    return this.byTenant.get(tenantId) ?? {};
  }

  set(tenantId: string, content: unknown): SiteContent {
    const clean = sanitizeSiteContent(content);
    this.byTenant.set(tenantId, clean);
    return clean;
  }

  has(tenantId: string): boolean {
    return this.byTenant.has(tenantId);
  }
}
