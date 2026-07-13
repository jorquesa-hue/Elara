// Browser-QA Phase 4B: the Purchasing view's budget row expands to a per-month
// budget-vs-actual bar chart. Asserts NO console errors.
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
config.setupForCountry(T, 'Greyline Living', 'US');
const app = new App({ authenticator: auth, config, roles: new RoleRegistry(), masterData: new MasterData() });
const bear = 'Bearer owner-demo';
app.dispatch({ method: 'POST', path: '/parties', bearer: bear, body: { id: 'pty-vendor', kind: 'organization', displayName: 'Ace Repairs' } });
app.dispatch({ method: 'POST', path: '/budgets', bearer: bear, body: { id: 'bud-1', account: 'expense:repairs', periodStart: '2026-07-01', periodEnd: '2026-10-01', amountCents: 900000, label: 'Q3 repairs' } });
app.dispatch({ method: 'POST', path: '/bills', bearer: bear, body: { id: 'b-jul', payeeId: 'pty-vendor', issuedAt: '2026-07-10T00:00:00Z', dueAt: '2026-07-20', lines: [{ description: 'roof', account: 'expense:repairs', amountCents: 250000 }] } });
app.dispatch({ method: 'POST', path: '/bills', bearer: bear, body: { id: 'b-aug', payeeId: 'pty-vendor', issuedAt: '2026-08-05T00:00:00Z', dueAt: '2026-08-20', lines: [{ description: 'hvac', account: 'expense:repairs', amountCents: 340000 }] } });

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
await page.getByRole('button', { name: 'Purchasing' }).click();
await page.waitForTimeout(400);
await page.getByRole('button', { name: 'Months ▾' }).click();
await page.waitForTimeout(400);

const text = await page.evaluate(() => document.body.innerText);
const monthsShown = /budget \(grey\) vs actual/.test(text) && /07/.test(text) && /08/.test(text) && /09/.test(text);

await page.screenshot({ path: process.argv[2] ?? '/tmp/claude-0/-home-user-Elara/8362700f-e9b3-5f80-9d7c-fe02ed300b4d/scratchpad/budget-months.png' });
await browser.close();
server.close();

console.log('monthly budget chart shown:', monthsShown);
console.log('console errors:', errors.length ? errors : 'NONE');
if (errors.length || !monthsShown) process.exit(1);
