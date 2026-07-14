// Browser-QA Phase 7A: the Distributions view — record an owner distribution to
// an SPE, see it listed with the total. NO console errors.
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
D('POST', '/legal-entities', { id: 'ent-spe', name: 'Northgate SPE LLC', role: 'spe' });
D('POST', '/properties', { id: 'prop-1', code: 'NG', name: 'Northgate', entityId: 'ent-spe' });

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
await page.getByRole('button', { name: 'Distributions' }).click();
await page.waitForTimeout(400);

await page.locator('form select').first().selectOption('ent-spe'); // owning entity
await page.locator('form select').nth(1).selectOption('prop-1'); // community
await page.getByPlaceholder('5000.00').fill('3000');
await page.getByPlaceholder('Q2 distribution').fill('Q2 draw');
await page.getByRole('button', { name: 'Record distribution' }).click();
await page.waitForTimeout(500);
const after = await page.evaluate(() => document.body.innerText);
const listed = /Northgate SPE LLC/.test(after) && /Q2 draw/.test(after);
const total = /Total distributed/i.test(after);

await page.screenshot({ path: process.argv[2] ?? '/tmp/claude-0/-home-user-Elara/8362700f-e9b3-5f80-9d7c-fe02ed300b4d/scratchpad/distributions.png' });
await browser.close();
server.close();

console.log('distribution listed:', listed);
console.log('total shown:', total);
console.log('console errors:', errors.length ? errors : 'NONE');
if (errors.length || !listed || !total) process.exit(1);
