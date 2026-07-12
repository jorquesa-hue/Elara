// Browser QA for the three new features: demo seeder, Reports view, Access advisor.
// Boots an empty owner tenant, completes setup, loads sample data from the
// dashboard CTA, then drives Reports + the Access advisor, asserting no console errors.
import { chromium } from 'playwright-core';
import { readdirSync } from 'node:fs';
import { App, StaticTokenAuthenticator, ConfigStore, RoleRegistry, MasterData, createHttpServer } from '../src/index.ts';

function findChrome(): string {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  const dir = readdirSync(root).find((d) => /^chromium-\d/.test(d));
  if (!dir) throw new Error(`no chromium under ${root}`);
  return `${root}/${dir}/chrome-linux/chrome`;
}
const T = 'jq';
const auth = new StaticTokenAuthenticator({ 'owner-demo': { actor: 'owner@jq', tenantId: T, role: 'owner' } });
const app = new App({ authenticator: auth, config: new ConfigStore(), roles: new RoleRegistry(), masterData: new MasterData() });
const server = createHttpServer(app);
await new Promise<void>((r) => server.listen(0, () => r()));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

const browser = await chromium.launch({ executablePath: findChrome(), args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 950 } })).newPage();
const errors: string[] = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

async function shot(n: string) { await page.waitForTimeout(250); await page.screenshot({ path: `./qa-shots/${n}.png`, fullPage: true }); console.log('shot:', n); }

await page.goto(base);
await page.evaluate(() => localStorage.setItem('usos.token', 'owner-demo'));
await page.reload();
await page.waitForSelector('text=Set up your workspace');
await page.fill('input', 'Ilhabela Stays');
await page.click('text=Finish setup');
await page.waitForSelector('text=Dashboard');
await shot('01-dashboard-empty');

// Load sample data from the CTA.
await page.click('button:has-text("Load sample data")');
await page.waitForTimeout(800);
await shot('02-dashboard-seeded');

// Reports view.
await page.click('nav button:has-text("Reports")');
await page.waitForSelector('text=What needs attention');
await page.waitForTimeout(600);
await shot('03-reports-insights');
await page.click('button:has-text("Receivables aging")');
await page.waitForTimeout(500);
await shot('04-reports-aging');
await page.click('button:has-text("Cash flow")');
await page.waitForTimeout(500);
await shot('05-reports-cashflow');

// Revenue management: KPIs + recommendations + rule editor + quote simulator.
await page.click('nav button:has-text("Revenue")');
await page.waitForSelector('text=Recommendations');
await page.waitForTimeout(600);
await shot('05a-revenue-cockpit');
// Run a quote to render the factor waterfall.
const quoteBtn = page.locator('button:has-text("Quote stay")').first();
if (await quoteBtn.count()) { await quoteBtn.click(); await page.waitForTimeout(500); }
await shot('05b-revenue-quote');

// People → access advisor.
await page.click('nav button:has-text("Users & Roles")');
await page.waitForSelector('text=Access advisor');
await page.fill('textarea', 'Front desk receptionist who checks guests in and takes payments but cannot issue refunds');
await page.click('button:has-text("Suggest access")');
await page.waitForSelector('text=Responsibilities matched');
await page.waitForTimeout(400);
await shot('06-access-advisor');

// A description that should propose a custom role.
await page.fill('textarea', 'runs overdue collections and also configures smart door locks and integrations');
await page.click('button:has-text("Suggest access")');
await page.waitForTimeout(600);
await shot('07-access-advisor-custom');

console.log(errors.length ? `\nCONSOLE ERRORS (${errors.length}):\n` + errors.join('\n') : '\nNO CONSOLE ERRORS');
await browser.close();
server.close();
process.exit(errors.length ? 1 : 0);
