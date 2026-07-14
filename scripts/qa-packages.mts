// Browser-QA Phase 6C: the Packages view — log a resident's parcel (notifying
// them), then mark it picked up. NO console errors.
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
D('POST', '/units', { id: 'u-1', code: 'A-1', label: 'Apt 101' });
D('POST', '/agreements', { id: 'ag-1', guestId: 'Bea Lima', unitId: 'u-1', kind: 'lease', start: '2026-01-01', end: '2027-01-01', rateCents: 300000 });
D('POST', '/agreements/ag-1/activate', {});
D('POST', '/parties', { id: 'pty-bea', kind: 'person', displayName: 'Bea Lima', email: 'bea@x.com' });
D('POST', '/agreements/ag-1/parties', { partyId: 'pty-bea', role: 'resident' });

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
await page.getByRole('button', { name: 'Packages' }).click();
await page.waitForTimeout(400);

await page.locator('form select').first().selectOption('pty-bea'); // recipient
await page.getByPlaceholder('large box').fill('large box');
await page.getByPlaceholder('Shelf B3').fill('Shelf B3');
await page.getByRole('button', { name: 'Log parcel' }).click();
await page.waitForTimeout(500);
const afterLog = await page.evaluate(() => document.body.innerText);
const logged = /Bea Lima/.test(afterLog) && /Shelf B3/.test(afterLog) && /notified/i.test(afterLog);

await page.getByRole('button', { name: 'Picked up' }).click();
await page.waitForTimeout(500);
const afterPickup = await page.evaluate(() => document.body.innerText);
const pickedUp = /picked up/i.test(afterPickup);

await page.screenshot({ path: process.argv[2] ?? '/tmp/claude-0/-home-user-Elara/8362700f-e9b3-5f80-9d7c-fe02ed300b4d/scratchpad/packages.png' });
await browser.close();
server.close();

console.log('parcel logged + notified:', logged);
console.log('pickup recorded:', pickedUp);
console.log('console errors:', errors.length ? errors : 'NONE');
if (errors.length || !logged || !pickedUp) process.exit(1);
