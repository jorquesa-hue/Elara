// Browser-QA Phase 6D: the Waitlist view — add a prospect for a floorplan, then
// convert them into a pipeline lead. NO console errors.
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
D('POST', '/unit-types', { id: 'ut-2br', code: '2BR', name: 'Two Bedroom' });

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
await page.getByRole('button', { name: 'Waitlist' }).click();
await page.waitForTimeout(400);

await page.getByPlaceholder('Prospect name').fill('Dana Reed');
await page.getByPlaceholder('prospect@email.com').fill('dana@x.com');
await page.locator('form select').first().selectOption('ut-2br');
await page.getByRole('button', { name: 'Join waitlist' }).click();
await page.waitForTimeout(500);
const afterJoin = await page.evaluate(() => document.body.innerText);
const joined = /Dana Reed/.test(afterJoin) && /Two Bedroom/.test(afterJoin) && /waiting/i.test(afterJoin);

await page.getByRole('button', { name: 'Convert' }).click();
await page.waitForTimeout(500);
const afterConvert = await page.evaluate(() => document.body.innerText);
const converted = /converted/i.test(afterConvert);

await page.screenshot({ path: process.argv[2] ?? '/tmp/claude-0/-home-user-Elara/8362700f-e9b3-5f80-9d7c-fe02ed300b4d/scratchpad/waitlist.png' });
await browser.close();
server.close();

console.log('prospect joined the waitlist:', joined);
console.log('converted to a lead:', converted);
console.log('console errors:', errors.length ? errors : 'NONE');
if (errors.length || !joined || !converted) process.exit(1);
