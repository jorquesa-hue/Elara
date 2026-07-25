// Website templates — 20 curated designs for the integrated booking site, each
// inspired by a recognizable archetype among the best property-marketing sites
// (marketplace freshness, urban minimalism, corporate furnished housing, resort,
// luxury multifamily, boutique hotel, coastal inn…). A template is DATA, not
// code: a palette, a font pairing, a corner radius, a hero layout and a card
// layout. The microsite renders any combination, so operators can pick a
// template and still adjust the pieces (radius, font, hero, cards) and their
// brand accent — flexibility without forking HTML. Pure + zero-dep.

export type FontKey = 'system' | 'inter' | 'space' | 'playfair' | 'fraunces' | 'libre';
export type RadiusKey = 'sharp' | 'soft' | 'round';
export type HeroStyle = 'classic' | 'banner' | 'split' | 'minimal' | 'editorial' | 'fullbleed';
export type CardStyle = 'grid' | 'list' | 'wide';

/** A cohesive design personality — a bundle of section/heading/button/card
 *  treatments the microsite applies together, so each template reads as a
 *  finished, bespoke design rather than a palette swap. */
export type FeelKey = 'editorial' | 'boutique' | 'resort' | 'minimal' | 'corporate' | 'student';
export const FEEL_KEYS: readonly FeelKey[] = ['editorial', 'boutique', 'resort', 'minimal', 'corporate', 'student'];

export const FONT_KEYS: readonly FontKey[] = ['system', 'inter', 'space', 'playfair', 'fraunces', 'libre'];
export const RADIUS_KEYS: readonly RadiusKey[] = ['sharp', 'soft', 'round'];
export const HERO_STYLES: readonly HeroStyle[] = ['classic', 'banner', 'split', 'minimal', 'editorial', 'fullbleed'];
export const CARD_STYLES: readonly CardStyle[] = ['grid', 'list', 'wide'];

/** A single font face + its Google Fonts import. */
interface FontSpec { family: string; import?: string }

/** Curated DISPLAY-serif + BODY-sans pairings — the signature of premium real-
 *  estate marketing sites (an elegant headline face over a clean, legible body).
 *  A template referencing a pairing gets serif headings and a sans body without
 *  the operator configuring anything. */
export type PairingKey =
  | 'cormorant' | 'playfair-jost' | 'fraunces-inter' | 'dmserif' | 'syne'
  | 'marcellus' | 'libre-work' | 'cormorant-work' | 'spectral' | 'bodoni'
  | 'outfit' | 'poppins' | 'archivo';

export const PAIRINGS: Record<PairingKey, { display: FontSpec; body: FontSpec }> = {
  cormorant: {
    display: { family: '"Cormorant Garamond",Georgia,serif', import: 'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600;700&display=swap' },
    body: { family: '"Inter",-apple-system,sans-serif', import: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap' },
  },
  'playfair-jost': {
    display: { family: '"Playfair Display",Georgia,serif', import: 'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@500;700&display=swap' },
    body: { family: '"Jost",-apple-system,sans-serif', import: 'https://fonts.googleapis.com/css2?family=Jost:wght@400;500;600&display=swap' },
  },
  'fraunces-inter': {
    display: { family: '"Fraunces",Georgia,serif', import: 'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&display=swap' },
    body: { family: '"Inter",-apple-system,sans-serif', import: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap' },
  },
  dmserif: {
    display: { family: '"DM Serif Display",Georgia,serif', import: 'https://fonts.googleapis.com/css2?family=DM+Serif+Display&display=swap' },
    body: { family: '"DM Sans",-apple-system,sans-serif', import: 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&display=swap' },
  },
  syne: {
    display: { family: '"Syne",-apple-system,sans-serif', import: 'https://fonts.googleapis.com/css2?family=Syne:wght@600;700;800&display=swap' },
    body: { family: '"Inter",-apple-system,sans-serif', import: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap' },
  },
  marcellus: {
    display: { family: '"Marcellus",Georgia,serif', import: 'https://fonts.googleapis.com/css2?family=Marcellus&display=swap' },
    body: { family: '"Inter",-apple-system,sans-serif', import: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap' },
  },
  'libre-work': {
    display: { family: '"Libre Baskerville",Georgia,serif', import: 'https://fonts.googleapis.com/css2?family=Libre+Baskerville:wght@400;700&display=swap' },
    body: { family: '"Work Sans",-apple-system,sans-serif', import: 'https://fonts.googleapis.com/css2?family=Work+Sans:wght@400;500;600&display=swap' },
  },
  'cormorant-work': {
    display: { family: '"Cormorant Garamond",Georgia,serif', import: 'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600;700&display=swap' },
    body: { family: '"Work Sans",-apple-system,sans-serif', import: 'https://fonts.googleapis.com/css2?family=Work+Sans:wght@400;500;600&display=swap' },
  },
  spectral: {
    display: { family: '"Spectral",Georgia,serif', import: 'https://fonts.googleapis.com/css2?family=Spectral:wght@500;600&display=swap' },
    body: { family: '"Inter",-apple-system,sans-serif', import: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap' },
  },
  bodoni: {
    display: { family: '"Bodoni Moda",Georgia,serif', import: 'https://fonts.googleapis.com/css2?family=Bodoni+Moda:opsz,wght@6..96,500;6..96,700&display=swap' },
    body: { family: '"Inter",-apple-system,sans-serif', import: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap' },
  },
  // Chunky geometric display faces — the student-housing register. Heavy weights,
  // tight tracking, nothing bookish: these read young and confident at size.
  outfit: {
    display: { family: '"Outfit",-apple-system,sans-serif', import: 'https://fonts.googleapis.com/css2?family=Outfit:wght@700;800;900&display=swap' },
    body: { family: '"Inter",-apple-system,sans-serif', import: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap' },
  },
  poppins: {
    display: { family: '"Poppins",-apple-system,sans-serif', import: 'https://fonts.googleapis.com/css2?family=Poppins:wght@700;800&display=swap' },
    body: { family: '"DM Sans",-apple-system,sans-serif', import: 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&display=swap' },
  },
  archivo: {
    display: { family: '"Archivo Black",-apple-system,sans-serif', import: 'https://fonts.googleapis.com/css2?family=Archivo+Black&display=swap' },
    body: { family: '"Work Sans",-apple-system,sans-serif', import: 'https://fonts.googleapis.com/css2?family=Work+Sans:wght@400;500;600&display=swap' },
  },
};

/** Font stacks + optional Google Fonts import. Serif/display faces apply to
 *  headings only (body stays a readable sans); sans faces style the whole page. */
export const FONTS: Record<FontKey, { family: string; import?: string; displayOnly: boolean }> = {
  system: { family: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif', displayOnly: false },
  inter: { family: '"Inter",-apple-system,BlinkMacSystemFont,sans-serif', import: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap', displayOnly: false },
  space: { family: '"Space Grotesk",-apple-system,sans-serif', import: 'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700&display=swap', displayOnly: false },
  playfair: { family: '"Playfair Display",Georgia,serif', import: 'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@500;700&display=swap', displayOnly: true },
  fraunces: { family: '"Fraunces",Georgia,serif', import: 'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,700&display=swap', displayOnly: true },
  libre: { family: '"Libre Baskerville",Georgia,serif', import: 'https://fonts.googleapis.com/css2?family=Libre+Baskerville:wght@400;700&display=swap', displayOnly: true },
};

const RADIUS_PX: Record<RadiusKey, number> = { sharp: 4, soft: 12, round: 22 };

export interface SitePalette {
  bg: string; card: string; line: string; text: string; muted: string;
  accent: string; accent2: string;
}

export interface SiteTemplate {
  id: string;
  name: string;
  description: string;
  /** The archetype it draws from — attribution of inspiration, not a copy. */
  inspiration: string;
  font: FontKey;
  radius: RadiusKey;
  hero: HeroStyle;
  cards: CardStyle;
  palette: SitePalette;
  /** Optional display+body font pairing (overrides `font` unless the operator
   *  explicitly picks a font). Premium templates use these. */
  pairing?: PairingKey;
  /** The design personality (section/heading/button/card treatment bundle). */
  feel?: FeelKey;
  /** The asset class the design is built to sell (defaults via SEGMENT_BY_ID). */
  segment?: SegmentKey;
}

const T = (t: SiteTemplate) => t;

/** Each template's design personality (kept as a map so the template literals
 *  stay compact; a template may also set `feel` inline to override). */
const FEEL_BY_ID: Record<string, FeelKey> = {
  classic: 'corporate', horizon: 'resort', minima: 'minimal', bluecorp: 'corporate', atlantica: 'resort',
  tropicalia: 'resort', metropolitan: 'editorial', residence: 'boutique', loftworks: 'minimal', nordic: 'minimal',
  ipanema: 'resort', vineyard: 'boutique', alpine: 'resort', urbannest: 'resort', skyline: 'editorial',
  noir: 'boutique', palmcourt: 'resort', hacienda: 'boutique', harborlight: 'corporate', zen: 'minimal',
  belmont: 'editorial', sablewood: 'editorial', saltair: 'boutique', archer: 'minimal', maison: 'boutique',
  verdant: 'resort', highline: 'editorial', terracotta: 'resort', aspen: 'boutique', onyx: 'minimal',
};
export function feelFor(t: SiteTemplate): FeelKey {
  return t.feel ?? FEEL_BY_ID[t.id] ?? 'corporate';
}

/** Which kind of asset a design is built to sell. This is how the sales team
 *  actually shops for a template — you pick the segment first, then the look. */
export type SegmentKey = 'multifamily' | 'student' | 'shortstay';
export const SEGMENT_KEYS: readonly SegmentKey[] = ['multifamily', 'student', 'shortstay'];
export const SEGMENT_LABELS: Record<SegmentKey, string> = {
  multifamily: 'Multifamily',
  student: 'Student housing',
  shortstay: 'Short-stay & hotel',
};

const SEGMENT_BY_ID: Record<string, SegmentKey> = {
  // Multifamily — apartment communities, leasing sites, residence brokerages.
  classic: 'multifamily', bluecorp: 'multifamily', metropolitan: 'multifamily', skyline: 'multifamily',
  highline: 'multifamily', belmont: 'multifamily', sablewood: 'multifamily', archer: 'multifamily',
  maison: 'multifamily', verdant: 'multifamily', onyx: 'multifamily',
  minima: 'multifamily', loftworks: 'multifamily', urbannest: 'multifamily',
  // Student housing — purpose-built for the PBSA market (see the student block in
  // SITE_TEMPLATES). The general-purpose designs that used to stand in here were
  // multifamily/short-stay looks in disguise, and are now filed accordingly.
  campushive: 'student', freshers: 'student', hallmates: 'student',
  quadnight: 'student', semester: 'student', studyloft: 'student',
  // Short-stay & hotel — nightly stays, resorts, inns, villas, lodges.
  horizon: 'shortstay', atlantica: 'shortstay', tropicalia: 'shortstay', residence: 'shortstay',
  nordic: 'shortstay', vineyard: 'shortstay', alpine: 'shortstay', noir: 'shortstay',
  hacienda: 'shortstay', harborlight: 'shortstay', saltair: 'shortstay', terracotta: 'shortstay',
  aspen: 'shortstay', ipanema: 'shortstay', palmcourt: 'shortstay', zen: 'shortstay',
};
export function segmentFor(t: SiteTemplate): SegmentKey {
  return t.segment ?? SEGMENT_BY_ID[t.id] ?? 'multifamily';
}

/** The catalog segment that best matches a tenant's business structure, so the
 *  picker opens on the designs that operator is actually shopping for. */
export function segmentForBusiness(structure: string | undefined): SegmentKey | '' {
  switch (structure) {
    case 'multifamily': case 'corporate_housing': return 'multifamily';
    case 'student_housing': return 'student';
    case 'short_stay': case 'boutique_hotel': return 'shortstay';
    default: return ''; // mixed_portfolio (or unknown) → show everything
  }
}

export const SITE_TEMPLATES: readonly SiteTemplate[] = [
  T({ id: 'classic', name: 'Elara Classic', description: 'The clean default — light, friendly, rounded cards.', inspiration: 'Modern SaaS booking pages', font: 'system', radius: 'soft', hero: 'classic', cards: 'grid',
    palette: { bg: '#f5f6fb', card: '#ffffff', line: '#e6e8f0', text: '#151a2e', muted: '#5b6480', accent: '#6d8bff', accent2: '#8b6cff' } }),
  T({ id: 'horizon', name: 'Horizon', description: 'Marketplace freshness: airy white, warm coral, big rounded photos.', inspiration: 'Airbnb-style marketplaces', font: 'inter', radius: 'round', hero: 'classic', cards: 'grid',
    palette: { bg: '#f7f7f8', card: '#ffffff', line: '#e8e8ea', text: '#222226', muted: '#6f6f76', accent: '#ff385c', accent2: '#e31c5f' } }),
  T({ id: 'minima', name: 'Minima', description: 'Urban minimalism: white space, near-black type, zero noise.', inspiration: 'Sonder-style design-led stays', font: 'inter', radius: 'sharp', hero: 'minimal', cards: 'wide',
    palette: { bg: '#ffffff', card: '#fafafa', line: '#ececec', text: '#111113', muted: '#6b7280', accent: '#111113', accent2: '#33333a' } }),
  T({ id: 'bluecorp', name: 'Corporate Blue', description: 'Furnished-housing polish: navy on white, split hero, tidy grid.', inspiration: 'Blueground-class corporate rentals', font: 'inter', radius: 'soft', hero: 'split', cards: 'grid',
    palette: { bg: '#f4f7fb', card: '#ffffff', line: '#dfe6f0', text: '#0f2547', muted: '#5c6f8d', accent: '#2557d6', accent2: '#1b3f9e' } }),
  T({ id: 'atlantica', name: 'Atlântica', description: 'Beach resort: sand tones, ocean teal, a big photo banner.', inspiration: 'Resort & Homes-and-Villas portals', font: 'fraunces', radius: 'soft', hero: 'banner', cards: 'wide',
    palette: { bg: '#f2efe9', card: '#fffdf8', line: '#e4ddd0', text: '#22333b', muted: '#71808a', accent: '#0f8b8d', accent2: '#0a6d6f' } }),
  T({ id: 'tropicalia', name: 'Tropicália', description: 'Lush dark green with sunset accents — made for island stays.', inspiration: 'Boutique eco-lodges', font: 'space', radius: 'round', hero: 'banner', cards: 'grid',
    palette: { bg: '#0e1f17', card: '#16291f', line: '#24402f', text: '#eef7ef', muted: '#9dbca7', accent: '#ffb703', accent2: '#fb8500' } }),
  T({ id: 'metropolitan', name: 'Metropolitan', description: 'Luxury multifamily: charcoal, gold, oversized serif headlines.', inspiration: 'Class-A apartment communities', font: 'playfair', radius: 'sharp', hero: 'editorial', cards: 'list',
    palette: { bg: '#101114', card: '#17181c', line: '#26272c', text: '#f2f0ea', muted: '#9a978c', accent: '#c9a961', accent2: '#b3903f' } }),
  T({ id: 'residence', name: 'Residence Club', description: 'Classic five-star: cream, deep green, serif calm.', inspiration: 'Grand-hotel residences', font: 'playfair', radius: 'soft', hero: 'split', cards: 'list',
    palette: { bg: '#f7f4ec', card: '#fffefa', line: '#e7e0cf', text: '#1c2b22', muted: '#6f7d6f', accent: '#14532d', accent2: '#0f3d22' } }),
  T({ id: 'loftworks', name: 'Loftworks', description: 'Industrial loft: dark slate, amber, squared edges.', inspiration: 'Converted-warehouse lofts', font: 'space', radius: 'sharp', hero: 'minimal', cards: 'list',
    palette: { bg: '#17181a', card: '#1f2023', line: '#2c2d31', text: '#e8e6e1', muted: '#8f8d86', accent: '#e8a13c', accent2: '#d4881f' } }),
  T({ id: 'nordic', name: 'Nordic Stay', description: 'Scandinavian calm: pale grays, slate blue, generous space.', inspiration: 'Nordic design hotels', font: 'system', radius: 'soft', hero: 'minimal', cards: 'wide',
    palette: { bg: '#f5f6f7', card: '#ffffff', line: '#e3e7ea', text: '#2b2f33', muted: '#7c8792', accent: '#5a7d9a', accent2: '#47657f' } }),
  T({ id: 'ipanema', name: 'Ipanema', description: 'Vibrant Brazilian energy: deep blue type, tropical green CTAs.', inspiration: 'Brazilian beach-house collectives', font: 'space', radius: 'round', hero: 'banner', cards: 'grid',
    palette: { bg: '#fffef7', card: '#ffffff', line: '#ece9db', text: '#14213d', muted: '#5f6a85', accent: '#06a77d', accent2: '#048364' } }),
  T({ id: 'vineyard', name: 'Vineyard', description: 'Wine-country inn: burgundy, cream, bookish serif.', inspiration: 'Countryside estates & wineries', font: 'libre', radius: 'soft', hero: 'split', cards: 'wide',
    palette: { bg: '#f8f3f1', card: '#fffbfa', line: '#ead9d6', text: '#3d1f24', muted: '#8a6a70', accent: '#7b2d3b', accent2: '#5e2130' } }),
  T({ id: 'alpine', name: 'Alpine Lodge', description: 'Chalet warmth: deep pine, ember orange, big cozy photos.', inspiration: 'Mountain lodges', font: 'fraunces', radius: 'soft', hero: 'banner', cards: 'wide',
    palette: { bg: '#131a17', card: '#1b2420', line: '#2a352f', text: '#edf2ee', muted: '#9db3a8', accent: '#d97742', accent2: '#b85c2e' } }),
  T({ id: 'urbannest', name: 'Urban Nest', description: 'Playful co-living: soft violet, friendly and rounded.', inspiration: 'Co-living communities', font: 'inter', radius: 'round', hero: 'classic', cards: 'grid',
    palette: { bg: '#f6f4ff', card: '#ffffff', line: '#e6e1f7', text: '#241e4e', muted: '#7a75a3', accent: '#6d4de0', accent2: '#8b6cff' } }),
  T({ id: 'skyline', name: 'Skyline', description: 'High-rise at night: near-black, electric blue, editorial type.', inspiration: 'Downtown tower leasing sites', font: 'inter', radius: 'sharp', hero: 'editorial', cards: 'grid',
    palette: { bg: '#0b0e14', card: '#121722', line: '#1f2634', text: '#e6ecf7', muted: '#7f8ba3', accent: '#3aa6ff', accent2: '#2478d4' } }),
  T({ id: 'noir', name: 'Boutique Noir', description: 'Dark luxury: espresso black, champagne gold, hushed serif.', inspiration: 'Boutique hotels', font: 'playfair', radius: 'soft', hero: 'minimal', cards: 'wide',
    palette: { bg: '#0d0b0a', card: '#161311', line: '#262019', text: '#f4ede2', muted: '#a39784', accent: '#d8b26a', accent2: '#c09a4b' } }),
  T({ id: 'palmcourt', name: 'Palm Court', description: 'Deco pastels: flamingo pink and pool teal, sunny and retro.', inspiration: 'Miami art-deco hotels', font: 'space', radius: 'round', hero: 'banner', cards: 'grid',
    palette: { bg: '#fdf6f0', card: '#ffffff', line: '#f3e4da', text: '#33415c', muted: '#8a93a6', accent: '#f4838f', accent2: '#2ec4b6' } }),
  T({ id: 'hacienda', name: 'Hacienda', description: 'Desert southwest: warm sand, copper, cactus green.', inspiration: 'Adobe estates & desert retreats', font: 'fraunces', radius: 'soft', hero: 'classic', cards: 'list',
    palette: { bg: '#f9f1e7', card: '#fffaf1', line: '#ecdcc8', text: '#4b3325', muted: '#97785f', accent: '#b3702b', accent2: '#57755d' } }),
  T({ id: 'harborlight', name: 'Harbor Light', description: 'New England coastal: crisp navy and white with a red buoy accent.', inspiration: 'Cape-style seaside inns', font: 'libre', radius: 'soft', hero: 'classic', cards: 'grid',
    palette: { bg: '#f6f8fa', card: '#ffffff', line: '#e2e8ef', text: '#1d3557', muted: '#6c7d92', accent: '#1d3557', accent2: '#e63946' } }),
  T({ id: 'zen', name: 'Zen Garden', description: 'Japandi quiet: warm neutrals, ink accents, wide calm cards.', inspiration: 'Japandi guesthouses', font: 'libre', radius: 'sharp', hero: 'minimal', cards: 'wide',
    palette: { bg: '#f4f1ea', card: '#fbf9f4', line: '#e4ded2', text: '#33322e', muted: '#8b877c', accent: '#4a4a45', accent2: '#6e6a5f' } }),

  // ---- Premium real-estate collection (font pairings + immersive heroes) -----
  T({ id: 'belmont', name: 'Belmont Estates', description: 'Luxury brokerage: ivory & forest green, a full-bleed hero photo, elegant Cormorant headlines over clean sans.', inspiration: "Sotheby's / luxury brokerages", pairing: 'cormorant', font: 'inter', radius: 'sharp', hero: 'fullbleed', cards: 'wide',
    palette: { bg: '#f7f5f0', card: '#ffffff', line: '#e6e2d8', text: '#1c2b24', muted: '#6f7a72', accent: '#1f3d2f', accent2: '#335643' } }),
  T({ id: 'sablewood', name: 'Sablewood', description: 'Dark editorial luxe: charcoal & warm brass, oversized serif headlines, an editorial magazine hero.', inspiration: 'The Modern House', pairing: 'playfair-jost', font: 'playfair', radius: 'sharp', hero: 'editorial', cards: 'list',
    palette: { bg: '#14120f', card: '#1c1a16', line: '#2c2924', text: '#f0ebe1', muted: '#a29a89', accent: '#c8a568', accent2: '#a8894f' } }),
  T({ id: 'saltair', name: 'Saltair', description: 'Coastal luxury: soft sand, slate blue and white, a wide full-bleed shoreline hero.', inspiration: 'Hamptons & Nantucket brokerages', pairing: 'marcellus', font: 'libre', radius: 'soft', hero: 'fullbleed', cards: 'wide',
    palette: { bg: '#f4f6f7', card: '#ffffff', line: '#dfe6ea', text: '#20323d', muted: '#6c8291', accent: '#3f6d86', accent2: '#8a9fab' } }),
  T({ id: 'archer', name: 'Archer', description: 'Contemporary architectural: off-white and ink, a bold Syne display, generous minimal layout.', inspiration: 'Modern architecture studios', pairing: 'syne', font: 'space', radius: 'sharp', hero: 'minimal', cards: 'wide',
    palette: { bg: '#fbfbf9', card: '#ffffff', line: '#e7e7e3', text: '#141414', muted: '#6d6d6a', accent: '#141414', accent2: '#8a5a3c' } }),
  T({ id: 'maison', name: 'Maison', description: 'Parisian boutique: cream & burgundy, a split hero, refined Fraunces headlines.', inspiration: 'Parisian pied-à-terre residences', pairing: 'fraunces-inter', font: 'fraunces', radius: 'soft', hero: 'split', cards: 'grid',
    palette: { bg: '#f8f4ee', card: '#fffdf9', line: '#e9e0d2', text: '#2a211c', muted: '#867a6c', accent: '#7c2b35', accent2: '#9c4a52' } }),
  T({ id: 'verdant', name: 'Verdant', description: 'Biophilic wellness: warm white and olive, a photo banner, high-contrast DM Serif display.', inspiration: 'Wellness & garden residences', pairing: 'dmserif', font: 'system', radius: 'round', hero: 'banner', cards: 'grid',
    palette: { bg: '#f6f5ee', card: '#ffffff', line: '#e6e6d7', text: '#26301f', muted: '#727a63', accent: '#586b3a', accent2: '#7c8f52' } }),
  T({ id: 'highline', name: 'Highline', description: 'New-York luxury tower: near-black, platinum and electric blue, an editorial hero.', inspiration: 'Manhattan high-rise leasing', pairing: 'bodoni', font: 'inter', radius: 'sharp', hero: 'editorial', cards: 'grid',
    palette: { bg: '#0c0d10', card: '#15171c', line: '#242730', text: '#eef1f6', muted: '#8b93a3', accent: '#7fa8d6', accent2: '#b8c4d4' } }),
  T({ id: 'terracotta', name: 'Terracotta', description: 'Mediterranean villa: terracotta, cream and olive, a sun-washed banner and warm serif.', inspiration: 'Tuscan & Mediterranean villas', pairing: 'cormorant-work', font: 'fraunces', radius: 'soft', hero: 'banner', cards: 'wide',
    palette: { bg: '#faf3ea', card: '#fffbf4', line: '#eaddc9', text: '#43302b', muted: '#98836c', accent: '#b5623a', accent2: '#7d7a45' } }),
  T({ id: 'aspen', name: 'Aspen', description: 'Mountain-modern luxe: warm stone, deep pine and ember, an immersive full-bleed hero.', inspiration: 'Aspen & alpine estates', pairing: 'spectral', font: 'fraunces', radius: 'soft', hero: 'fullbleed', cards: 'wide',
    palette: { bg: '#f5f2ec', card: '#fffdf8', line: '#e5ded1', text: '#2b2620', muted: '#847c6d', accent: '#1f3b30', accent2: '#c06a3d' } }),
  T({ id: 'onyx', name: 'Onyx', description: 'Ultra-minimal luxury: black, white and a single hairline of gold — a quiet full-bleed statement.', inspiration: 'Single-property luxury listings', pairing: 'marcellus', font: 'playfair', radius: 'sharp', hero: 'fullbleed', cards: 'wide',
    palette: { bg: '#0a0a0b', card: '#141416', line: '#26262a', text: '#f3f2ef', muted: '#9b9a95', accent: '#c9b079', accent2: '#e7e5df' } }),
  // --- STUDENT HOUSING -------------------------------------------------------
  // Benchmarked against UK and Australian PBSA operators. That market sells to
  // 18-year-olds and their parents, and its sites look nothing like multifamily:
  // saturated colour blocking, heavy geometric display type, pill buttons, fat
  // rounded cards, and social/community photography rather than empty interiors.
  T({ id: 'campushive', name: 'Campus Hive', description: 'Electric violet and acid lime, huge chunky headlines — the loudest, most social of the student set.', inspiration: 'Australian PBSA operators (Melbourne/Sydney towers)', pairing: 'outfit', font: 'inter', radius: 'round', hero: 'banner', cards: 'grid', feel: 'student', segment: 'student',
    palette: { bg: '#f8f5ff', card: '#ffffff', line: '#e4d9ff', text: '#190f33', muted: '#6a5b93', accent: '#7c3aed', accent2: '#a3e635' } }),
  T({ id: 'freshers', name: 'Freshers', description: 'Bold navy with a hit of highlighter yellow — confident, friendly, unmistakably first-year.', inspiration: 'Large UK PBSA portfolios', pairing: 'poppins', font: 'inter', radius: 'round', hero: 'banner', cards: 'grid', feel: 'student', segment: 'student',
    palette: { bg: '#fffdf2', card: '#ffffff', line: '#e6e3d3', text: '#131c47', muted: '#5d6485', accent: '#1b2a6b', accent2: '#ffd21f' } }),
  T({ id: 'hallmates', name: 'Hallmates', description: 'Vivid teal and coral on white — bright, welcoming and easy to book from a phone.', inspiration: 'UK student-accommodation booking portals', pairing: 'outfit', font: 'inter', radius: 'round', hero: 'classic', cards: 'grid', feel: 'student', segment: 'student',
    palette: { bg: '#f1fbfa', card: '#ffffff', line: '#cdeae7', text: '#0d2b28', muted: '#4f7a76', accent: '#00b3a4', accent2: '#ff5a5f' } }),
  T({ id: 'quadnight', name: 'Quad', description: 'Dark mode for night owls: near-black with electric blue and magenta, neon-poster energy.', inspiration: 'Student towers with a nightlife-forward brand', pairing: 'archivo', font: 'space', radius: 'round', hero: 'fullbleed', cards: 'grid', feel: 'student', segment: 'student',
    palette: { bg: '#0d0f1c', card: '#171b30', line: '#272d4a', text: '#f2f4ff', muted: '#9aa3c8', accent: '#4d7cff', accent2: '#ff3d9a' } }),
  T({ id: 'semester', name: 'Semester', description: 'Warm cream, tangerine and deep plum — softer and homelier, aimed at parents as much as students.', inspiration: 'Boutique student residences', pairing: 'poppins', font: 'inter', radius: 'round', hero: 'split', cards: 'wide', feel: 'student', segment: 'student',
    palette: { bg: '#fff7ef', card: '#ffffff', line: '#f0ddc9', text: '#2c1338', muted: '#7a5f7f', accent: '#ff6b35', accent2: '#5b2a86' } }),
  T({ id: 'studyloft', name: 'Study Loft', description: 'Fresh green and ink with sunny highlights — co-living warmth, study-space calm.', inspiration: 'Co-living and student co-op communities', pairing: 'outfit', font: 'inter', radius: 'round', hero: 'banner', cards: 'grid', feel: 'student', segment: 'student',
    palette: { bg: '#f4fbf4', card: '#ffffff', line: '#d5ebd6', text: '#12261a', muted: '#4e7357', accent: '#16a34a', accent2: '#facc15' } }),
];

const BY_ID = new Map(SITE_TEMPLATES.map((t) => [t.id, t]));
export const DEFAULT_TEMPLATE_ID = 'classic';

export function isKnownTemplate(id: string): boolean {
  return BY_ID.has(id);
}

export interface TemplateOptions {
  radius?: RadiusKey;
  font?: FontKey;
  hero?: HeroStyle;
  cards?: CardStyle;
}

/** What the microsite consumes: template + adjustments + brand accent, flattened. */
export interface ResolvedTheme {
  id: string;
  name: string;
  palette: SitePalette;
  heroBg: string; // fallback hero background when no hero photo is set
  radiusPx: number;
  hero: HeroStyle;
  cards: CardStyle;
  feel: FeelKey;
  font: { family: string; import?: string; displayOnly: boolean };
  /** Display face for headings, when the template uses a serif/sans pairing.
   *  The body then uses `font` (a sans) and headings use this. */
  heading?: { family: string; import?: string };
}

/** Template + operator adjustments + brand accent → one flat theme. The brand
 *  color (Settings → Branding) overrides the template accent so a picked design
 *  still carries the operator's identity. */
export function resolveTheme(templateId?: string, options?: TemplateOptions, brandColor?: string): ResolvedTheme {
  const tpl = BY_ID.get(templateId ?? '') ?? BY_ID.get(DEFAULT_TEMPLATE_ID)!;
  const palette: SitePalette = { ...tpl.palette };
  if (brandColor && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(brandColor)) {
    palette.accent = brandColor;
    palette.accent2 = brandColor;
  }
  const radiusKey = options?.radius && RADIUS_KEYS.includes(options.radius) ? options.radius : tpl.radius;
  const fontOverride = options?.font && FONT_KEYS.includes(options.font) ? options.font : undefined;
  // A template's serif/sans pairing wins UNLESS the operator explicitly picks a
  // font (then that single choice governs, dropping the pairing).
  let font: { family: string; import?: string; displayOnly: boolean };
  let heading: { family: string; import?: string } | undefined;
  if (tpl.pairing && !fontOverride) {
    const pr = PAIRINGS[tpl.pairing];
    font = { family: pr.body.family, ...(pr.body.import ? { import: pr.body.import } : {}), displayOnly: false };
    heading = { family: pr.display.family, ...(pr.display.import ? { import: pr.display.import } : {}) };
  } else {
    const f = FONTS[fontOverride ?? tpl.font];
    font = { family: f.family, ...(f.import ? { import: f.import } : {}), displayOnly: f.displayOnly };
  }
  return {
    id: tpl.id,
    name: tpl.name,
    palette,
    heroBg: `linear-gradient(135deg, ${palette.accent}, ${palette.accent2})`,
    radiusPx: RADIUS_PX[radiusKey],
    hero: options?.hero && HERO_STYLES.includes(options.hero) ? options.hero : tpl.hero,
    cards: options?.cards && CARD_STYLES.includes(options.cards) ? options.cards : tpl.cards,
    feel: feelFor(tpl),
    font,
    ...(heading ? { heading } : {}),
  };
}

/** The gallery summaries the portal's template picker renders. */
export function templateGallery(): Array<{ id: string; name: string; description: string; inspiration: string; hero: HeroStyle; cards: CardStyle; feel: FeelKey; segment: SegmentKey; segmentLabel: string; font: FontKey; radius: RadiusKey; swatch: string[] }> {
  return SITE_TEMPLATES.map((t) => ({
    id: t.id, name: t.name, description: t.description, inspiration: t.inspiration,
    hero: t.hero, cards: t.cards, feel: feelFor(t), segment: segmentFor(t), segmentLabel: SEGMENT_LABELS[segmentFor(t)],
    font: t.font, radius: t.radius,
    swatch: [t.palette.bg, t.palette.card, t.palette.accent, t.palette.accent2, t.palette.text],
  }));
}
