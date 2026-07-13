// Browser-QA Phase 5C: the Maintenance view's Preventive maintenance panel —
// add a schedule, run the PM sweep (raises a work order). NO console errors.
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
await page.getByRole('button', { name: 'Maintenance' }).click();
await page.waitForTimeout(400);

await page.getByPlaceholder('HVAC service').fill('HVAC service');
await page.locator('input[type="date"]').first().fill('2026-07-01');
await page.getByRole('button', { name: 'Add schedule' }).click();
await page.waitForTimeout(400);
const afterAdd = await page.evaluate(() => document.body.innerText);
const scheduleListed = /HVAC service/.test(afterAdd) && /every 90d/.test(afterAdd);

await page.getByRole('button', { name: 'Run PM sweep' }).click();
await page.waitForTimeout(500);
const afterSweep = await page.evaluate(() => document.body.innerText);
// After the sweep the schedule's next-due advanced (2026-07-01 → 2026-09-29).
const swept = /2026-09-29/.test(afterSweep);

await page.screenshot({ path: process.argv[2] ?? '/tmp/claude-0/-home-user-Elara/8362700f-e9b3-5f80-9d7c-fe02ed300b4d/scratchpad/pm.png' });
await browser.close();
server.close();

console.log('PM schedule listed:', scheduleListed);
console.log('sweep advanced next-due:', swept);
console.log('console errors:', errors.length ? errors : 'NONE');
if (errors.length || !scheduleListed || !swept) process.exit(1);
