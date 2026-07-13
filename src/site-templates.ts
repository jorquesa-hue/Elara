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
export type HeroStyle = 'classic' | 'banner' | 'split' | 'minimal' | 'editorial';
export type CardStyle = 'grid' | 'list' | 'wide';

export const FONT_KEYS: readonly FontKey[] = ['system', 'inter', 'space', 'playfair', 'fraunces', 'libre'];
export const RADIUS_KEYS: readonly RadiusKey[] = ['sharp', 'soft', 'round'];
export const HERO_STYLES: readonly HeroStyle[] = ['classic', 'banner', 'split', 'minimal', 'editorial'];
export const CARD_STYLES: readonly CardStyle[] = ['grid', 'list', 'wide'];

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
}

const T = (t: SiteTemplate) => t;

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
  font: { family: string; import?: string; displayOnly: boolean };
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
  const fontKey = options?.font && FONT_KEYS.includes(options.font) ? options.font : tpl.font;
  const radiusKey = options?.radius && RADIUS_KEYS.includes(options.radius) ? options.radius : tpl.radius;
  const f = FONTS[fontKey];
  return {
    id: tpl.id,
    name: tpl.name,
    palette,
    heroBg: `linear-gradient(135deg, ${palette.accent}, ${palette.accent2})`,
    radiusPx: RADIUS_PX[radiusKey],
    hero: options?.hero && HERO_STYLES.includes(options.hero) ? options.hero : tpl.hero,
    cards: options?.cards && CARD_STYLES.includes(options.cards) ? options.cards : tpl.cards,
    font: { family: f.family, ...(f.import ? { import: f.import } : {}), displayOnly: f.displayOnly },
  };
}

/** The gallery summaries the portal's template picker renders. */
export function templateGallery(): Array<{ id: string; name: string; description: string; inspiration: string; hero: HeroStyle; cards: CardStyle; font: FontKey; radius: RadiusKey; swatch: string[] }> {
  return SITE_TEMPLATES.map((t) => ({
    id: t.id, name: t.name, description: t.description, inspiration: t.inspiration,
    hero: t.hero, cards: t.cards, font: t.font, radius: t.radius,
    swatch: [t.palette.bg, t.palette.card, t.palette.accent, t.palette.accent2, t.palette.text],
  }));
}
