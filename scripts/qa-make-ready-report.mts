// Browser-QA Phase 5B: the Reports catalog gains "Make-ready (turn time)".
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
const NOW = '2026-07-21T00:00:00Z';
const auth = new StaticTokenAuthenticator({ 'owner-demo': { actor: 'ana@demo', tenantId: T, role: 'owner' } });
const md = new MasterData();
md.units.add({ id: 'u-1', tenantId: T, code: 'A-1', label: 'Apt 101', active: true });
const config = new ConfigStore();
config.setupForCountry(T, 'Greyline Living', 'US');
const app = new App({ authenticator: auth, config, roles: new RoleRegistry(), masterData: md, now: () => NOW });
app.dispatch({ method: 'POST', path: '/turns', bearer: 'Bearer owner-demo', body: { id: 'turn-1', unitId: 'u-1', vacatedAt: '2026-07-01T00:00:00Z' } });

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
await page.getByRole('button', { name: 'Reports' }).click();
await page.waitForTimeout(300);
await page.getByRole('button', { name: 'Report catalog' }).click();
await page.waitForTimeout(400);
await page.getByRole('button', { name: 'Make-ready (turn time)' }).click();
await page.waitForTimeout(500);

const text = await page.evaluate(() => document.body.innerText);
const rendered = /In turn/i.test(text) && /Longest open/i.test(text) && /Apt 101/.test(text);

await page.screenshot({ path: process.argv[2] ?? '/tmp/claude-0/-home-user-Elara/8362700f-e9b3-5f80-9d7c-fe02ed300b4d/scratchpad/make-ready-report.png' });
await browser.close();
server.close();

console.log('make-ready report rendered:', rendered);
console.log('console errors:', errors.length ? errors : 'NONE');
if (errors.length || !rendered) process.exit(1);
