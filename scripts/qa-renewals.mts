// Browser-QA the Phase 2D Renewals view: preview due leases, run the sweep, renew.
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
// Fix "today" so the seeded lease sits inside the 90-day window deterministically.
const NOW = '2026-07-13T00:00:00Z';
const auth = new StaticTokenAuthenticator({ 'owner-demo': { actor: 'ana@demo', tenantId: T, role: 'owner' } });
const md = new MasterData();
md.units.add({ id: 'u-1', tenantId: T, code: 'A-1', label: 'Apt 101', active: true });
const config = new ConfigStore();
config.setupForCountry(T, 'Greyline Living', 'US');
const app = new App({ authenticator: auth, config, roles: new RoleRegistry(), masterData: md, now: () => NOW });
const bear = 'Bearer owner-demo';
app.dispatch({ method: 'POST', path: '/agreements', bearer: bear, body: { id: 'ag-1', guestId: 'Bea Lima', unitId: 'u-1', kind: 'lease', start: '2025-09-01', end: '2026-09-01', rateCents: 300000 } });
app.dispatch({ method: 'POST', path: '/agreements/ag-1/activate', bearer: bear, body: {} });

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

await page.getByRole('button', { name: 'Renewals' }).click();
await page.waitForTimeout(400);
const listedText = await page.evaluate(() => document.body.innerText);
const hasDue = /Bea Lima/.test(listedText) && /3,150\.00/.test(listedText);

await page.getByRole('button', { name: 'Run renewal sweep' }).click();
await page.waitForTimeout(400);

await page.getByRole('button', { name: 'Renew', exact: true }).first().click();
await page.waitForTimeout(500);
const afterText = await page.evaluate(() => document.body.innerText);
const renewedGone = /No leases due for renewal/.test(afterText);

await page.screenshot({ path: process.argv[2] ?? '/tmp/claude-0/-home-user-Elara/8362700f-e9b3-5f80-9d7c-fe02ed300b4d/scratchpad/renewals.png' });
await browser.close();
server.close();

console.log('due lease listed with proposed rent:', hasDue);
console.log('renewed → list cleared:', renewedGone);
console.log('console errors:', errors.length ? errors : 'NONE');
if (errors.length || !hasDue || !renewedGone) process.exit(1);
