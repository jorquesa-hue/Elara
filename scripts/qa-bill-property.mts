// Browser-QA Phase 4A: the Bills form gains a Property select; a property-stamped
// bill's expense shows up attributed on the owner statement. Asserts NO console errors.
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
app.dispatch({ method: 'POST', path: '/properties', bearer: bear, body: { id: 'prop-north', code: 'NORTH', name: 'Northgate' } });
app.dispatch({ method: 'POST', path: '/parties', bearer: bear, body: { id: 'pty-vendor', kind: 'organization', displayName: 'Ace Repairs' } });

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

await page.getByRole('button', { name: 'Bills' }).click();
await page.waitForTimeout(400);

// Fill the bill form, choosing the property.
await page.getByRole('combobox').last().selectOption({ label: 'Northgate' }).catch(() => {});
await page.locator('input[type="number"]').first().fill('50000');
await page.getByRole('button', { name: 'Record bill' }).click();
await page.waitForTimeout(500);

const bodyText = await page.evaluate(() => document.body.innerText);
const billBooked = /pty-vendor|Ace Repairs|50/.test(bodyText);

// Verify the owner statement attributes the expense to Northgate (via the API).
const attributed = await page.evaluate(async (tok) => {
  const r = await fetch('/reports/owner_statement?from=2026-07-01&to=2026-08-01', { headers: { authorization: 'Bearer ' + tok } });
  const j = await r.json();
  const rows = (j.report && j.report.rows) || [];
  return rows.some((x: { property: string; expenses: number }) => x.property === 'Northgate' && x.expenses === 50000);
}, 'owner-demo');

await page.screenshot({ path: process.argv[2] ?? '/tmp/claude-0/-home-user-Elara/8362700f-e9b3-5f80-9d7c-fe02ed300b4d/scratchpad/bill-property.png' });
await browser.close();
server.close();

console.log('bill booked:', billBooked);
console.log('expense attributed to Northgate on owner statement:', attributed);
console.log('console errors:', errors.length ? errors : 'NONE');
if (errors.length || !attributed) process.exit(1);
