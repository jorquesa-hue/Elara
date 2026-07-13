// Browser-QA the Phase 2E Tours view: schedule a tour, confirm, complete → the
// linked lead advances to toured. Asserts NO console errors.
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
md.units.add({ id: 'u-1', tenantId: T, code: 'A-1', label: 'Apt 101', active: true });
const config = new ConfigStore();
config.setupForCountry(T, 'Greyline Living', 'US');
const app = new App({ authenticator: auth, config, roles: new RoleRegistry(), masterData: md });
app.dispatch({ method: 'POST', path: '/leads', bearer: 'Bearer owner-demo', body: { id: 'ld-1', name: 'Bea Lima', source: 'website', estValueCents: 300000 } });

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

await page.getByRole('button', { name: 'Tours' }).click();
await page.waitForTimeout(300);

await page.getByPlaceholder('Prospect name').fill('Bea Lima');
await page.getByPlaceholder('prospect@email.com').fill('bea@x.com');
await page.locator('input[type="datetime-local"]').fill('2026-07-20T15:00');
await page.getByRole('button', { name: 'Schedule tour' }).click();
await page.waitForTimeout(400);

await page.getByRole('button', { name: 'Confirm' }).click();
await page.waitForTimeout(300);
await page.getByRole('button', { name: 'Complete' }).click();
await page.waitForTimeout(400);

const bodyText = await page.evaluate(() => document.body.innerText);
const completed = /completed/i.test(bodyText);

await page.screenshot({ path: process.argv[2] ?? '/tmp/claude-0/-home-user-Elara/8362700f-e9b3-5f80-9d7c-fe02ed300b4d/scratchpad/tours.png' });
await browser.close();
server.close();

console.log('tour completed row present:', completed);
console.log('console errors:', errors.length ? errors : 'NONE');
if (errors.length || !completed) process.exit(1);
