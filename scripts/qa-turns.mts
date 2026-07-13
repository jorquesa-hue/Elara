// Browser-QA Phase 5A: the Make-ready board — open a turn, complete the checklist,
// mark the unit rent-ready. Asserts NO console errors.
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
const md = new MasterData();
md.units.add({ id: 'u-1', tenantId: T, code: 'A-1', label: 'Apt 101', active: true });
const config = new ConfigStore();
config.setupForCountry(T, 'Greyline Living', 'US');
const app = new App({ authenticator: auth, config, roles: new RoleRegistry(), masterData: md, now: () => NOW });

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
await page.getByRole('button', { name: 'Make-ready' }).click();
await page.waitForTimeout(300);

// Open a turn on Apt 101.
await page.getByRole('combobox').first().selectOption({ label: 'Apt 101' }).catch(() => {});
await page.getByRole('button', { name: 'Open turn' }).click();
await page.waitForTimeout(500);
const openText = await page.evaluate(() => document.body.innerText);
const boardShown = /Apt 101/.test(openText) && /Deep clean/.test(openText) && /turn/.test(openText);

// Complete all five checklist tasks, then mark rent-ready.
for (const label of ['Deep clean', 'Paint / touch-up', 'Repairs', 'Final inspection', 'Re-key / access']) {
  await page.getByRole('button', { name: label }).click();
  await page.waitForTimeout(200);
}
await page.getByRole('button', { name: 'Mark rent-ready' }).click();
await page.waitForTimeout(500);
const readyText = await page.evaluate(() => document.body.innerText);
const madeReady = /ready/i.test(readyText);

await page.screenshot({ path: process.argv[2] ?? '/tmp/claude-0/-home-user-Elara/8362700f-e9b3-5f80-9d7c-fe02ed300b4d/scratchpad/turns.png' });
await browser.close();
server.close();

console.log('make-ready board rendered:', boardShown);
console.log('unit marked rent-ready:', madeReady);
console.log('console errors:', errors.length ? errors : 'NONE');
if (errors.length || !boardShown || !madeReady) process.exit(1);
