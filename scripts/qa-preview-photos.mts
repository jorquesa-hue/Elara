// Browser QA for design-preview photography. This sandbox cannot reach any image
// host, so the two paths are proven by stubbing at the network layer:
//   A. the CDN serves the photo   → every tile paints a real <img>
//   B. the CDN 404s               → the fallback source paints instead (no holes)
// What is being verified is the wiring, not the sandbox's connectivity.
import { chromium } from 'playwright-core';
import { readdirSync } from 'node:fs';
import { App, StaticTokenAuthenticator, ConfigStore, RoleRegistry, MasterData, createHttpServer } from '../src/index.ts';

function fc() {
  const r = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  const d = readdirSync(r).find((x) => /^chromium-\d/.test(x))!;
  return `${r}/${d}/chrome-linux/chrome`;
}
// Opaque 2x2 solids — stand in for the CDN photo so a painted tile is unmistakable.
const CDN_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGOo6qsAIgYIBQAqFgYB3zJ6IgAAAABJRU5ErkJggg==', 'base64');
const ALT_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGN4bd/wHwgZIBQAOEQIAWvVCu0AAAAASUVORK5CYII=', 'base64');

const auth = new StaticTokenAuthenticator({ o: { actor: 'a', tenantId: 'jq', role: 'owner' } });
const app = new App({ authenticator: auth, config: new ConfigStore(), roles: new RoleRegistry(), masterData: new MasterData() });
app.dispatch({ method: 'PUT', path: '/config', bearer: 'Bearer o', body: { displayName: 'Belmont Residences', country: 'US' } });
app.dispatch({ method: 'POST', path: '/demo/seed', bearer: 'Bearer o', body: {} });
const s = createHttpServer(app);
await new Promise<void>((r) => s.listen(0, () => r()));
const port = (s.address() as { port: number }).port;

const b = await chromium.launch({ executablePath: fc(), args: ['--no-sandbox'] });
const errs: string[] = [];

async function run(label: string, cdnWorks: boolean) {
  const pg = await (await b.newContext({ viewport: { width: 1280, height: 940 } })).newPage();
  pg.on('console', (m) => { if (m.type() === 'error' && !/ERR_|Failed to load resource|fonts\.g/.test(m.text())) errs.push(m.text()); });
  pg.on('pageerror', (e) => errs.push('PE:' + e.message));
  await pg.route('**fonts.googleapis.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await pg.route('**images.unsplash.com/**', (r) => cdnWorks
    ? r.fulfill({ status: 200, contentType: 'image/png', body: CDN_PNG })                          // the real CDN
    : r.fulfill({ status: 404, contentType: 'text/plain', body: 'gone' }));                        // a dead id
  await pg.route('**loremflickr.com/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: ALT_PNG }));
  await pg.route('**picsum.photos/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: ALT_PNG }));

  await pg.goto(`http://127.0.0.1:${port}/site/jq?template=belmont&demo=1`);
  await pg.waitForFunction(`document.querySelectorAll('#results .card').length > 0`, { timeout: 20000 });
  // Gallery tiles are loading="lazy" — scroll them in before counting.
  await pg.evaluate(`window.scrollTo(0, document.body.scrollHeight)`);
  await pg.waitForTimeout(1500);
  await pg.evaluate(`window.scrollTo(0, 0)`);
  await pg.waitForTimeout(900);
  const info = await pg.evaluate(`(() => {
    // The lightbox <img> ships empty until a photo is opened — not a tile.
    const imgs = Array.from(document.images).filter(i => !!i.getAttribute('src'));
    const shown = imgs.filter(i => i.complete && i.naturalWidth > 0 && i.style.display !== 'none');
    const hero = getComputedStyle(document.documentElement).getPropertyValue('--heroimg').trim();
    return {
      total: imgs.length,
      unpainted: imgs.filter(i => !(i.complete && i.naturalWidth > 0)).map(i => (i.getAttribute('alt')||'?') + ' :: ' + i.src.slice(0, 60)),
      painted: shown.length,
      hidden: imgs.filter(i => i.style.display === 'none').length,
      viaFallback: imgs.filter(i => /picsum|loremflickr/.test(i.src)).length,
      propertyKeyword: imgs.filter(i => /loremflickr/.test(i.src)).length,
      hero: hero && hero !== 'none' ? (/picsum|loremflickr/.test(hero) ? 'fallback photo' : 'cdn photo') : 'GRADIENT (no photo)',
    };
  })()`);
  if (info.unpainted.length) console.log('   unpainted →', info.unpainted.join(' ; '));
  console.log(label.padEnd(26), '→ imgs painted ' + info.painted + '/' + info.total,
    '| hidden=' + info.hidden, '| via fallback=' + info.viaFallback + ' (property-keyword ' + info.propertyKeyword + ')', '| hero=' + info.hero);
  await pg.screenshot({ path: `/home/user/Elara/tpl-shots/photos-${cdnWorks ? 'cdn' : 'fallback'}.png` });
  return info;
}

const a = await run('A. photo CDN serves', true);
const c = await run('B. photo CDN 404s', false);
console.log('every tile has a photo in both worlds:', a.painted === a.total && a.painted > 0 && c.painted === c.total && c.painted > 0);
console.log('a dead CDN id is rescued by the fallback:', c.viaFallback === c.total && c.hero === 'fallback photo');
console.log(errs.length ? 'ERRORS:' + errs.join('|') : 'NO CONSOLE ERRORS');
await b.close();
s.close();
