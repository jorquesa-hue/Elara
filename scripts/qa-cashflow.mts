// Browser-QA Phase 4C: the Reports catalog gains "Statement of cash flows".
// Seeds the demo portfolio (real payments + bill payments), opens the report,
// asserts it renders opening/closing KPIs with NO console errors.
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
const config = new ConfigStore();
config.setupForCountry(T, 'Ilhabela Stays', 'BR', { locale: 'en' });
const app = new App({ authenticator: auth, config, roles: new RoleRegistry(), masterData: new MasterData() });
app.dispatch({ method: 'POST', path: '/demo/seed', bearer: 'Bearer owner-demo', body: {} });

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
await page.getByRole('button', { name: 'Statement of cash flows' }).click();
await page.waitForTimeout(500);

const text = await page.evaluate(() => document.body.innerText);
const rendered = /Opening cash/i.test(text) && /Closing cash/i.test(text) && /Operating activities/i.test(text);

await page.screenshot({ path: process.argv[2] ?? '/tmp/claude-0/-home-user-Elara/8362700f-e9b3-5f80-9d7c-fe02ed300b4d/scratchpad/cashflow.png' });
await browser.close();
server.close();

console.log('cash flow statement rendered:', rendered);
console.log('console errors:', errors.length ? errors : 'NONE');
if (errors.length || !rendered) process.exit(1);
