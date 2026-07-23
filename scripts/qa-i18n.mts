// Browser-QA the header language switcher: switch EN → FR → DE and confirm the
// menus re-render in each language, with NO console errors.
import { chromium } from 'playwright-core';
import { readdirSync } from 'node:fs';
import { App, StaticTokenAuthenticator, ConfigStore, RoleRegistry, MasterData, createHttpServer } from '../src/index.ts';

function findChrome(): string {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  const dir = readdirSync(root).find((d) => /^chromium-\d/.test(d));
  if (!dir) throw new Error(`no chromium under ${root}`);
  return `${root}/${dir}/chrome-linux/chrome`;
}
const T = 't-mer';
const auth = new StaticTokenAuthenticator({ 'owner-mer': { actor: 'ana', tenantId: T, role: 'owner' } });
const config = new ConfigStore();
config.setupForCountry(T, 'Meridian Living', 'GB');
const app = new App({ authenticator: auth, config, roles: new RoleRegistry(), masterData: new MasterData() });

const server = createHttpServer(app);
await new Promise<void>((r) => server.listen(0, () => r()));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

const browser = await chromium.launch({ executablePath: findChrome(), args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const errors: string[] = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(base);
await page.evaluate((tok) => localStorage.setItem('usos.token', tok), 'owner-mer');
await page.reload();
await page.waitForSelector('.langsel', { timeout: 4000 });

const langCount = await page.locator('.langsel option').count();

// Switch to French → expect a French menu label (Settings → Paramètres).
await page.locator('.langsel').selectOption('fr');
await page.waitForTimeout(400);
const fr = await page.evaluate(() => document.body.innerText);
const frOk = /Paramètres/.test(fr) && /Approbations|Relevés propriétaire|Distributions/.test(fr);

// Switch to German → expect German menu labels.
await page.locator('.langsel').selectOption('de');
await page.waitForTimeout(400);
const de = await page.evaluate(() => document.body.innerText);
const deOk = /Einstellungen/.test(de) && /Objekte|Ausschüttungen|Benutzer und Rollen/.test(de);

const out = process.argv[2] ?? '/tmp/claude-0/-home-user-Elara/8362700f-e9b3-5f80-9d7c-fe02ed300b4d/scratchpad/i18n-de.png';
await page.screenshot({ path: out });

await browser.close();
server.close();

console.log('language options:', langCount, '| FR menus:', frOk, '| DE menus:', deOk);
console.log('console errors:', errors.length ? errors : 'NONE');
if (langCount !== 6 || !frOk || !deOk || errors.length) process.exit(1);
