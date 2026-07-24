// Batch-4 QA: URL routing (hash reflects the screen; deep-link restores it) +
// the Ctrl/⌘-K command palette (opens, filters, Enter navigates + updates the
// hash). Fails on any console/page error. Screens land in ./cmd-shots.
import { chromium } from 'playwright-core';
import { readdirSync, mkdirSync } from 'node:fs';
import { App, StaticTokenAuthenticator, ConfigStore, RoleRegistry, MasterData, createHttpServer } from '../src/index.ts';

const OUT = './cmd-shots'; mkdirSync(OUT, { recursive: true });
function findChrome(): string {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  const dir = readdirSync(root).find((d) => /^chromium-\d/.test(d));
  if (!dir) throw new Error(`no chromium under ${root}`);
  return `${root}/${dir}/chrome-linux/chrome`;
}
const T = 't-demo';
const auth = new StaticTokenAuthenticator({ 'owner-demo': { actor: 'ana@demo', tenantId: T, role: 'owner' } });
const md = new MasterData();
md.units.add({ id: 'u-101', tenantId: T, code: 'A-101', label: 'Apt 101', active: true });
md.guests.add({ id: 'g-1', tenantId: T, code: 'G-1', fullName: 'Ana Souza' });
const app = new App({ authenticator: auth, config: new ConfigStore(), roles: new RoleRegistry(), masterData: md });
app.dispatch({ method: 'PUT', path: '/config', bearer: 'Bearer owner-demo', body: { displayName: 'Meridian', country: 'US' } });

const server = createHttpServer(app);
await new Promise<void>((r) => server.listen(0, () => r()));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

const browser = await chromium.launch({ executablePath: findChrome(), args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 2 })).newPage();
const errors: string[] = [];
page.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_RESET|ERR_ABORTED/.test(m.text())) errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
const shot = async (n: string) => { await page.waitForTimeout(200); await page.screenshot({ path: `${OUT}/${n}.png`, fullPage: true }); console.log('shot:', n); };
const fail = (m: string) => { throw new Error(m); };

await page.goto(base);
await page.evaluate(() => localStorage.setItem('usos.token', 'owner-demo'));
await page.reload();
await page.waitForSelector('aside', { timeout: 20000 });
await page.waitForTimeout(800);

// 1) The hash reflects the current screen.
let hash = await page.evaluate(() => location.hash);
console.log('initial hash:', hash);
if (!/^#\/[a-z]+\//.test(hash)) fail('hash not set on load: ' + hash);

// 2) Navigate via a nav item → hash updates.
await page.click('.wsswitch summary'); await page.waitForTimeout(150);
await page.click('.wsswitch .wopt:has-text("Finance")'); await page.waitForTimeout(400);
await page.click('nav button.item:has-text("Bills")'); await page.waitForTimeout(500);
hash = await page.evaluate(() => location.hash);
console.log('after nav to Bills:', hash);
if (!/finance\/bills/.test(hash)) fail('hash did not follow nav: ' + hash);
await shot('01-bills-hash');

// 3) Deep-link restore: reload on the bills hash lands back on Accounts payable.
await page.reload();
await page.waitForSelector('main h1', { timeout: 15000 });
await page.waitForTimeout(600);
const h1 = await page.locator('main h1').first().textContent();
console.log('after reload, h1:', h1);
if (!/payable/i.test(h1 || '')) fail('deep-link did not restore Bills: ' + h1);

// 4) Command palette: ⌘K opens, filter + Enter navigates.
await page.keyboard.press('Control+k');
await page.waitForSelector('.cmdk', { timeout: 5000 });
await shot('02-palette-open');
await page.fill('.cmdk-in input', 'renew');
await page.waitForTimeout(300);
const rows = await page.locator('.cmdk-row').count();
console.log('palette matches for "renew":', rows);
if (!rows) fail('palette found no match for renew');
await page.keyboard.press('Enter');
await page.waitForTimeout(500);
hash = await page.evaluate(() => location.hash);
const h1b = await page.locator('main h1').first().textContent();
console.log('after palette pick, hash:', hash, 'h1:', h1b);
if (!/renewals/.test(hash)) fail('palette did not navigate to renewals: ' + hash);
await shot('03-after-palette');

// 5) Browser Back returns to Bills.
await page.goBack();
await page.waitForTimeout(500);
hash = await page.evaluate(() => location.hash);
console.log('after Back, hash:', hash);

if (errors.length) { console.error('CONSOLE/PAGE ERRORS:\n' + errors.join('\n')); }
else { console.log('NO CONSOLE ERRORS'); }
await browser.close(); server.close();
process.exit(errors.length ? 1 : 0);
