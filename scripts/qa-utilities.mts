// Browser-QA Phase 6B: the Utilities view — add a master water bill for a
// property, see it allocated equally across two leases, and bill residents.
// NO console errors.
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
const NOW = '2026-07-13T00:00:00Z';
const auth = new StaticTokenAuthenticator({ 'owner-demo': { actor: 'ana@demo', tenantId: T, role: 'owner' } });
const config = new ConfigStore();
config.setupForCountry(T, 'Greyline Living', 'US');
const app = new App({ authenticator: auth, config, roles: new RoleRegistry(), masterData: new MasterData(), now: () => NOW });

const D = (method: string, path: string, body: Record<string, unknown>) => app.dispatch({ method, path, bearer: 'Bearer owner-demo', body });
D('POST', '/properties', { id: 'prop-1', code: 'NG', name: 'Northgate' });
for (const n of ['1', '2']) {
  D('POST', '/units', { id: 'u-' + n, code: 'A-' + n, label: 'Apt 10' + n, propertyId: 'prop-1' });
  D('POST', '/agreements', { id: 'ag-' + n, guestId: 'Resident ' + n, unitId: 'u-' + n, kind: 'lease', start: '2026-01-01', end: '2027-01-01', rateCents: 300000 });
  D('POST', '/agreements/ag-' + n + '/activate', {});
}

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
await page.getByRole('button', { name: 'Utilities' }).click();
await page.waitForTimeout(400);

await page.locator('form select').first().selectOption('prop-1'); // property
await page.getByPlaceholder('250.00').fill('250');
const dates = page.locator('input[type="date"]');
await dates.nth(0).fill('2026-06-01');
await dates.nth(1).fill('2026-07-01');
await page.getByRole('button', { name: 'Add bill' }).click();
await page.waitForTimeout(500);
const afterAdd = await page.evaluate(() => document.body.innerText);
// Equal split of $250 across two leases -> $125 each.
const allocated = /Resident 1/.test(afterAdd) && /Resident 2/.test(afterAdd);

await page.getByRole('button', { name: 'Bill residents' }).click();
await page.waitForTimeout(500);
const afterBill = await page.evaluate(() => document.body.innerText);
const billed = /billed/i.test(afterBill);

await page.screenshot({ path: process.argv[2] ?? '/tmp/claude-0/-home-user-Elara/8362700f-e9b3-5f80-9d7c-fe02ed300b4d/scratchpad/utilities.png' });
await browser.close();
server.close();

console.log('allocation shown across leases:', allocated);
console.log('billed status reached:', billed);
console.log('console errors:', errors.length ? errors : 'NONE');
if (errors.length || !allocated || !billed) process.exit(1);
