// Browser QA for the Website module's Design catalog: every template card must
// render the REAL microsite in a scaled iframe (so the sales team browses actual
// designs), the feel filter must narrow the grid, and picking a card must retarget
// the big live preview. Photos 404 in this sandbox (egress-blocked) and degrade to
// the template gradient via the microsite's onerror fallbacks — that is expected.
import { chromium } from 'playwright-core';
import { readdirSync } from 'node:fs';
import { App, StaticTokenAuthenticator, ConfigStore, RoleRegistry, MasterData, createHttpServer } from '../src/index.ts';

function fc() {
  const r = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  const d = readdirSync(r).find((x) => /^chromium-\d/.test(x))!;
  return `${r}/${d}/chrome-linux/chrome`;
}

const auth = new StaticTokenAuthenticator({ o: { actor: 'a', tenantId: 'jq', role: 'owner' } });
const app = new App({ authenticator: auth, config: new ConfigStore(), roles: new RoleRegistry(), masterData: new MasterData() });
app.dispatch({ method: 'PUT', path: '/config', bearer: 'Bearer o', body: { displayName: 'Belmont Residences', country: 'US' } });
app.dispatch({ method: 'POST', path: '/demo/seed', bearer: 'Bearer o', body: {} });

const s = createHttpServer(app);
await new Promise<void>((r) => s.listen(0, () => r()));
const port = (s.address() as { port: number }).port;

const b = await chromium.launch({ executablePath: fc(), args: ['--no-sandbox'] });
const errs: string[] = [];
const ctx = await b.newContext({ viewport: { width: 1360, height: 1000 } });
const pg = await ctx.newPage();
pg.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_RESET|ERR_ABORTED|Failed to load resource|fonts\.g|ERR_NAME_NOT_RESOLVED|ERR_TUNNEL/.test(m.text())) errs.push(m.text()); });
pg.on('pageerror', (e) => errs.push('PE:' + e.message));
// This sandbox blocks fonts.googleapis.com and the request HANGS, which stalls
// first paint of every framed microsite (a pending render-blocking stylesheet).
// A real browser resolves it; stub it so the thumbnails actually paint here.
await pg.route('**fonts.googleapis.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
await pg.route('**images.unsplash.com/**', (r) => r.abort());

await pg.goto(`http://127.0.0.1:${port}/`);
await pg.evaluate(`localStorage.setItem('usos.token','o')`);
await pg.goto(`http://127.0.0.1:${port}/#/commercial/website`);
await pg.reload();
await pg.waitForSelector('.tplcard', { timeout: 20000 });
await pg.waitForTimeout(1800);

const shape = await pg.evaluate(`(() => {
  const cards = document.querySelectorAll('.tplcard');
  const frames = document.querySelectorAll('.tplthumb iframe');
  const first = document.querySelector('.tplthumb');
  const box = first ? first.getBoundingClientRect() : null;
  return {
    cards: cards.length,
    chips: document.querySelectorAll('.tplchip').length,
    frames: frames.length,
    scaled: Array.from(frames).every(f => /scale\\(0\\./.test(f.style.transform)),
    landscape: box ? (box.width > box.height && box.height > 100) : false,
    sel: document.querySelectorAll('.tplcard.sel').length,
  };
})()`);
console.log('cards=' + shape.cards, '| chips=' + shape.chips, '| loaded frames=' + shape.frames, '| all scaled=' + shape.scaled, '| landscape thumb=' + shape.landscape, '| selected=' + shape.sel);

// Each loaded frame must point at the live microsite for its own template.
const targets = await pg.evaluate(`Array.from(document.querySelectorAll('.tplthumb iframe')).slice(0,4).map(f => f.getAttribute('src'))`);
console.log('frame targets →', targets.join(' , '));
await pg.waitForFunction(`(() => {
  const f = document.querySelector('.tplthumb iframe');
  return !!(f && f.contentDocument && f.contentDocument.body && f.contentDocument.body.getAttribute('data-feel'));
})()`, { timeout: 20000 });
const rendered = await pg.evaluate(`(() => {
  const f = document.querySelector('.tplthumb iframe');
  if (!f || !f.contentDocument) return null;
  const d = f.contentDocument;
  return { feel: d.body.getAttribute('data-feel'), hero: d.body.getAttribute('data-hero'), units: d.querySelectorAll('#results .card').length };
})()`);
console.log('first thumbnail rendered →', JSON.stringify(rendered));

// Filter by personality.
await pg.evaluate(`Array.from(document.querySelectorAll('.tplchip')).find(c => c.textContent === 'Boutique').click()`);
await pg.waitForTimeout(350);
const filtered = await pg.evaluate(`(() => {
  const all = Array.from(document.querySelectorAll('.tplcard'));
  const vis = all.filter(c => c.style.display !== 'none');
  return { visible: vis.length, total: all.length, onChip: (document.querySelector('.tplchip.on') || {}).textContent };
})()`);
console.log('filter Boutique →', filtered.visible + '/' + filtered.total, 'visible | active chip=' + filtered.onChip);
await pg.evaluate(`Array.from(document.querySelectorAll('.tplchip')).find(c => c.textContent === 'All designs').click()`);
await pg.waitForTimeout(250);

// Picking a card selects it and retargets the big live preview.
const picked = await pg.evaluate(`(() => {
  const cards = Array.from(document.querySelectorAll('.tplcard'));
  const target = cards.find(c => (c.querySelector('strong') || {}).textContent === 'Onyx') || cards[3];
  target.click();
  return (target.querySelector('strong') || {}).textContent;
})()`);
await pg.waitForTimeout(700);
const after = await pg.evaluate(`(() => {
  const sel = document.querySelector('.tplcard.sel');
  const big = Array.from(document.querySelectorAll('iframe')).find(f => f.getAttribute('title') === 'Design preview');
  return { selName: sel ? sel.querySelector('strong').textContent : null, previewSrc: big ? big.getAttribute('src') : null };
})()`);
console.log('picked "' + picked + '" → selected=' + after.selName, '| live preview src=' + after.previewSrc);

await pg.evaluate(`document.querySelector('.tplgrid').scrollIntoView()`);
await pg.waitForTimeout(2500);
await pg.screenshot({ path: '/home/user/Elara/tpl-shots/design-catalog.png', fullPage: false });
console.log(errs.length ? 'ERRORS:' + errs.join('|') : 'NO CONSOLE ERRORS');
await b.close();
s.close();
