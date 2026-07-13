// Browser-QA the Phase 2C ILS syndication panel in the Website view: connect an
// ILS, syndicate the feed. Asserts NO console errors.
import { chromium } from 'playwright-core';
import { readdirSync } from 'node:fs';
import { App, StaticTokenAuthenticator, ConfigStore, RoleRegistry, MasterData, createHttpServer } from '../src/index.ts';

function findChrome(): string {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  const dir = readdirSync(root).find((d) => /^chromium-\d/.test(d));
  if (!dir) throw new Error(`no chromium under ${root}`);
  return `${root}/${dir}/chrome-linux/chrome`;
}
const T = 't-demo';
const auth = new StaticTokenAuthenticator({ 'owner-demo': { actor: 'ana@demo', tenantId: T, role: 'owner' } });
const md = new MasterData();
for (const n of ['101', '102']) md.units.add({ id: `u-${n}`, tenantId: T, code: `A-${n}`, label: `Apt ${n}`, active: true });
const config = new ConfigStore();
config.setupForCountry(T, 'Greyline Living', 'US');
const app = new App({ authenticator: auth, config, roles: new RoleRegistry(), masterData: md });
// Connect an active ILS integration.
app.dispatch({ method: 'POST', path: '/integrations', bearer: 'Bearer owner-demo', body: { id: 'int-ils', kind: 'ils', provider: 'zillow', secretRef: 'ils-key', config: { baseUrl: 'https://ils.example' } } });

const server = createHttpServer(app);
await new Promise<void>((r) => server.listen(0, () => r()));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

const browser = await chromium.launch({ executablePath: findChrome(), args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const errors: string[] = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
page.on('response', (r) => { if (r.status() === 404) errors.push('404 ' + r.url()); });

await page.goto(base);
await page.evaluate((tok) => localStorage.setItem('usos.token', tok), 'owner-demo');
await page.reload();
await page.waitForTimeout(400);

await page.getByRole('button', { name: 'Website' }).click();
await page.waitForTimeout(500);

const beforeText = await page.evaluate(() => document.body.innerText);
const hasPanel = /Listing syndication/.test(beforeText) && /ready to syndicate/.test(beforeText);

await page.getByRole('button', { name: 'Syndicate to zillow' }).click();
await page.waitForTimeout(500);
const afterText = await page.evaluate(() => document.body.innerText);
const syndicated = /Syndicated 2 listings/.test(afterText);

await page.screenshot({ path: process.argv[2] ?? '/tmp/claude-0/-home-user-Elara/8362700f-e9b3-5f80-9d7c-fe02ed300b4d/scratchpad/ils.png' });
await browser.close();
server.close();

console.log('ILS panel rendered:', hasPanel);
console.log('syndicated toast:', syndicated);
console.log('console errors:', errors.length ? errors : 'NONE');
if (errors.length || !hasPanel || !syndicated) process.exit(1);
