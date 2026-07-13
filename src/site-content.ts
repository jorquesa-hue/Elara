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
  amenities?: string[];
  /** data:image/* base64 (≤256 KB) or an https URL. */
  photoDataUrl?: string;
}

export interface SiteContent {
  heroTitle?: string;
  about?: string;
  contactEmail?: string;
  contactPhone?: string;
  whatsapp?: string;
  instagram?: string;
  facebook?: string;
  units?: Record<string, UnitSiteDetails>;
}

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
  const about = str(raw['about'], MAX_TEXT); if (about) out.about = about;
  for (const k of ['contactEmail', 'contactPhone', 'whatsapp', 'instagram', 'facebook'] as const) {
    const v = str(raw[k]); if (v) out[k] = v;
  }
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
      if (Array.isArray(d['amenities'])) {
        const am = (d['amenities'] as unknown[]).map((a) => str(a, 60)).filter((a): a is string => !!a).slice(0, MAX_AMENITIES);
        if (am.length) det.amenities = am;
      }
      const photo = str(d['photoDataUrl'], 300 * 1024);
      if (photo) det.photoDataUrl = assertSitePhoto(photo);
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
