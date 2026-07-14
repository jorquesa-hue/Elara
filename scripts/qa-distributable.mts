// Browser-QA Phase 7C: the distributable-cash guardrail on the Distributions
// view — picking an entity shows its distributable headroom, and an over-
// distributable draw is parked for approval (toast) not recorded. NO console errors.
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
D('POST', '/units', { id: 'u-1', code: 'A-1', label: 'Apt 101', propertyId: 'prop-1' });
D('POST', '/agreements', { id: 'ag-1', guestId: 'Bea Lima', unitId: 'u-1', kind: 'lease', start: '2026-01-01', end: '2027-01-01', rateCents: 300000 });
D('POST', '/agreements/ag-1/activate', {});
// NOI = $2,000 -> distributable $2,000.
D('POST', '/invoices', { id: 'inv-noi', agreementId: 'ag-1', issuedAt: NOW, dueAt: '2026-07-20', lines: [{ description: 'rent', account: 'revenue:room', amountCents: 200000 }] });

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

await page.locator('form select').first().selectOption('ent-spe'); // triggers onchange -> distributable
await page.waitForTimeout(400);
const afterPick = await page.evaluate(() => document.body.innerText);
const headroom = /Distributable now/i.test(afterPick);

// Try to over-distribute ($5,000 draw > $2,000 distributable) -> parked for approval.
await page.getByPlaceholder('5000.00').fill('5000');
await page.getByPlaceholder('Q2 distribution').fill('Over-draw');
await page.getByRole('button', { name: 'Record distribution' }).click();
await page.waitForTimeout(500);
const afterSubmit = await page.evaluate(() => document.body.innerText);
const parked = /Parked for approval/i.test(afterSubmit);
// It must NOT appear in the list (nothing recorded).
const notRecorded = !/Over-draw/.test(afterSubmit);

await page.screenshot({ path: process.argv[2] ?? '/tmp/claude-0/-home-user-Elara/8362700f-e9b3-5f80-9d7c-fe02ed300b4d/scratchpad/distributable.png' });
await browser.close();
server.close();

console.log('distributable headroom shown:', headroom);
console.log('over-draw parked for approval:', parked);
console.log('over-draw not recorded:', notRecorded);
console.log('console errors:', errors.length ? errors : 'NONE');
if (errors.length || !headroom || !parked || !notRecorded) process.exit(1);
