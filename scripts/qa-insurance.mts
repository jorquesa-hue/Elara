// Browser-QA Phase 6A: the Insurance view — add a renters-insurance policy
// against a lease and see it listed as compliant with the KPI row. NO console errors.
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

// Seed a unit + active lease so the Insurance form has a lease to attach to.
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
await page.getByRole('button', { name: 'Insurance' }).click();
await page.waitForTimeout(400);

await page.locator('form select').first().selectOption('ag-1');
await page.getByPlaceholder('Lemonade').fill('Lemonade');
await page.getByPlaceholder('POL-12345').fill('POL-777');
await page.getByPlaceholder('100000').fill('100000');
const dates = page.locator('input[type="date"]');
await dates.nth(0).fill('2026-06-01');
await dates.nth(1).fill('2027-06-01');
await page.getByRole('button', { name: 'Add policy' }).click();
await page.waitForTimeout(500);
const afterAdd = await page.evaluate(() => document.body.innerText);
const listed = /Lemonade/.test(afterAdd) && /compliant/i.test(afterAdd);
const kpiShown = /Compliance rate/i.test(afterAdd);

await page.screenshot({ path: process.argv[2] ?? '/tmp/claude-0/-home-user-Elara/8362700f-e9b3-5f80-9d7c-fe02ed300b4d/scratchpad/insurance.png' });
await browser.close();
server.close();

console.log('policy listed compliant:', listed);
console.log('KPI row shown:', kpiShown);
console.log('console errors:', errors.length ? errors : 'NONE');
if (errors.length || !listed || !kpiShown) process.exit(1);
