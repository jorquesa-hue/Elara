// Tranche 57 — website templates. 20 curated designs (palette + font + radius +
// hero layout + card layout) resolved server-side with operator adjustments and
// the brand accent. Registry integrity, resolveTheme semantics, sanitize rules,
// the gallery endpoint, and the public site carrying the resolved theme. 12 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SITE_TEMPLATES, resolveTheme, templateGallery, isKnownTemplate, DEFAULT_TEMPLATE_ID, FONTS, HERO_STYLES, CARD_STYLES, RADIUS_KEYS, FONT_KEYS } from '../src/site-templates.ts';
import { sanitizeSiteContent } from '../src/site-content.ts';
import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';

const NOW = '2026-07-11T00:00:00Z';
const HEX = /^#[0-9a-fA-F]{6}$/;

function seededApp() {
  const mgr: AuthContext = { actor: 'm', tenantId: 'jq', role: 'owner' };
  const app = new App({ authenticator: new StaticTokenAuthenticator({ mgr }), now: () => NOW });
  app.dispatch({ method: 'POST', path: '/demo/seed', bearer: 'Bearer mgr', body: {} });
  return app;
}
const D = (app: App, method: string, path: string, token: string | null, body?: Record<string, unknown>) =>
  app.dispatch({ method, path, ...(token ? { bearer: `Bearer ${token}` } : {}), body: body ?? {} });

test('exactly 20 templates with unique ids', () => {
  assert.equal(SITE_TEMPLATES.length, 20);
  assert.equal(new Set(SITE_TEMPLATES.map((t) => t.id)).size, 20);
  assert.ok(isKnownTemplate(DEFAULT_TEMPLATE_ID));
});

test('registry integrity: every template has a full valid palette + valid enums', () => {
  for (const t of SITE_TEMPLATES) {
    for (const k of ['bg', 'card', 'line', 'text', 'muted', 'accent', 'accent2'] as const) {
      assert.match(t.palette[k], HEX, `${t.id}.palette.${k} = ${t.palette[k]}`);
    }
    assert.ok(HERO_STYLES.includes(t.hero), `${t.id} hero`);
    assert.ok(CARD_STYLES.includes(t.cards), `${t.id} cards`);
    assert.ok(RADIUS_KEYS.includes(t.radius), `${t.id} radius`);
    assert.ok(FONT_KEYS.includes(t.font), `${t.id} font`);
    assert.ok(FONTS[t.font], `${t.id} font stack`);
    assert.ok(t.name && t.description && t.inspiration, `${t.id} copy`);
  }
});

test('the templates genuinely vary: multiple hero styles, card styles and fonts in use', () => {
  assert.ok(new Set(SITE_TEMPLATES.map((t) => t.hero)).size === 5, 'all 5 hero styles used');
  assert.ok(new Set(SITE_TEMPLATES.map((t) => t.cards)).size === 3, 'all 3 card styles used');
  assert.ok(new Set(SITE_TEMPLATES.map((t) => t.font)).size >= 5, 'font variety');
});

test('resolveTheme falls back to the default for unknown/missing template ids', () => {
  assert.equal(resolveTheme(undefined).id, DEFAULT_TEMPLATE_ID);
  assert.equal(resolveTheme('does-not-exist').id, DEFAULT_TEMPLATE_ID);
});

test('resolveTheme: the brand color overrides the template accent', () => {
  const th = resolveTheme('metropolitan', undefined, '#e0533a');
  assert.equal(th.palette.accent, '#e0533a');
  assert.equal(th.palette.accent2, '#e0533a');
  // …but not the rest of the palette.
  assert.equal(th.palette.bg, '#101114');
});

test('resolveTheme: operator adjustments override template defaults', () => {
  const th = resolveTheme('minima', { radius: 'round', hero: 'banner', cards: 'grid', font: 'fraunces' });
  assert.equal(th.radiusPx, 22);
  assert.equal(th.hero, 'banner');
  assert.equal(th.cards, 'grid');
  assert.match(th.font.family, /Fraunces/);
  assert.equal(th.font.displayOnly, true);
});

test('sanitize keeps a known template + valid options, drops junk', () => {
  const c = sanitizeSiteContent({ template: 'noir', templateOptions: { radius: 'sharp', hero: 'nonsense', cards: 'wide', font: 'comic-sans' } });
  assert.equal(c.template, 'noir');
  assert.deepEqual(c.templateOptions, { radius: 'sharp', cards: 'wide' }); // bad hero/font dropped
  const bad = sanitizeSiteContent({ template: 'not-a-template' });
  assert.equal(bad.template, undefined);
});

test('GET /site-templates returns the 20-design gallery (masterdata.read)', () => {
  const app = seededApp();
  const res = D(app, 'GET', '/site-templates', 'mgr');
  assert.equal(res.status, 200);
  const tps = (res.body as { templates: Array<{ id: string; swatch: string[] }> }).templates;
  assert.equal(tps.length, 20);
  assert.equal(tps[0]!.swatch.length, 5);
  assert.equal(templateGallery().length, 20);
});

test('the public site config carries the resolved theme for the picked template', () => {
  const app = seededApp();
  D(app, 'PUT', '/site-content', 'mgr', { content: { template: 'tropicalia' } });
  const site = D(app, 'GET', '/site/jq/config', null);
  const theme = (site.body as { theme: { id: string; palette: { bg: string }; hero: string } }).theme;
  assert.equal(theme.id, 'tropicalia');
  assert.equal(theme.palette.bg, '#0e1f17');
  assert.equal(theme.hero, 'banner');
});

test('the theme folds in brand color + adjustments end to end', () => {
  const app = seededApp();
  D(app, 'PUT', '/config', 'mgr', { brandColor: '#123abc' });
  D(app, 'PUT', '/site-content', 'mgr', { content: { template: 'zen', templateOptions: { cards: 'grid' } } });
  const theme = (D(app, 'GET', '/site/jq/config', null).body as { theme: { palette: { accent: string }; cards: string; radiusPx: number } }).theme;
  assert.equal(theme.palette.accent, '#123abc');
  assert.equal(theme.cards, 'grid'); // adjusted away from zen's wide
  assert.equal(theme.radiusPx, 4); // zen default sharp preserved
});

test('?template= previews a design without touching the saved choice', () => {
  const app = seededApp();
  D(app, 'PUT', '/site-content', 'mgr', { content: { template: 'tropicalia' } });
  // Preview zen: the response is themed zen and flagged as a preview…
  const prev = D(app, 'GET', '/site/jq/config', null, { template: 'zen' }).body as { theme: { id: string }; previewTemplate?: string };
  assert.equal(prev.theme.id, 'zen');
  assert.equal(prev.previewTemplate, 'zen');
  // …an unknown id is ignored, and the saved template is untouched.
  const junk = D(app, 'GET', '/site/jq/config', null, { template: 'nope' }).body as { theme: { id: string }; previewTemplate?: string };
  assert.equal(junk.theme.id, 'tropicalia');
  assert.equal(junk.previewTemplate, undefined);
  const plain = D(app, 'GET', '/site/jq/config', null).body as { theme: { id: string } };
  assert.equal(plain.theme.id, 'tropicalia');
});

test('template choice survives snapshot → rehydrate', () => {
  const app = seededApp();
  D(app, 'PUT', '/site-content', 'mgr', { content: { template: 'harborlight', templateOptions: { radius: 'round' } } });
  const world = app.snapshotWorld('jq');
  const mgr: AuthContext = { actor: 'm', tenantId: 'jq', role: 'owner' };
  const b = new App({ authenticator: new StaticTokenAuthenticator({ mgr }), now: () => NOW });
  b.rehydrate(world);
  const theme = (D(b, 'GET', '/site/jq/config', null).body as { theme: { id: string; radiusPx: number } }).theme;
  assert.equal(theme.id, 'harborlight');
  assert.equal(theme.radiusPx, 22);
});
