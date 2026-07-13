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

// Reports & analytics workbench.
await page.click('nav button:has-text("Reports")');
await page.waitForSelector('text=What needs attention');
await page.waitForTimeout(600);
await shot('03-reports-insights');
// Catalog tab: the PMS staples.
await page.click('button:has-text("Report catalog")');
await page.waitForTimeout(500);
await page.click('button:has-text("Rent roll")');
await page.waitForTimeout(500);
await shot('04a-rent-roll');
await page.click('button:has-text("Delinquency")');
await page.waitForTimeout(500);
await shot('04b-delinquency');
await page.click('button:has-text("Lease expirations")');
await page.waitForTimeout(500);
await shot('04c-lease-expirations');
await page.click('button:has-text("Portfolio mix")');
await page.waitForTimeout(500);
await shot('04-reports-catalog-chart');
// Build tab: compose a custom report + chart.
await page.click('button:has-text("Build a report")');
await page.waitForSelector('text=Data source');
await page.waitForTimeout(700);
await shot('05-reports-builder');
// Save it to the dashboard, then view the dashboard.
const saveBtn = page.locator('button:has-text("Save to dashboard")').first();
if (await saveBtn.count()) { await saveBtn.click(); await page.waitForTimeout(400); }
await page.click('button:has-text("My dashboard")');
await page.waitForTimeout(700);
await shot('05c-reports-dashboard');

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

// Properties: add a unit.
await page.click('nav button:has-text("Properties")');
await page.waitForSelector('text=bookable inventory');
await page.fill('input[placeholder="ILH-201"]', 'ILH-999');
await page.fill('input[placeholder="Praia do Curral — Apto 201"]', 'Casa Nova — Test');
await page.click('button:has-text("Add property")');
await page.waitForTimeout(500);
await shot('08-properties');

// Website: the operator's booking-site link + published units.
await page.click('nav button:has-text("Website")');
await page.waitForSelector('text=public booking link');
await page.waitForTimeout(600);
await shot('09-website-panel');

// The PUBLIC booking microsite (as a guest — new page, no auth).
const pub = await (await browser.newContext({ viewport: { width: 1200, height: 950 } })).newPage();
const pubErrors: string[] = [];
pub.on('console', (m) => { if (m.type() === 'error') pubErrors.push(m.text()); });
pub.on('pageerror', (e) => pubErrors.push('PAGEERROR: ' + e.message));
await pub.goto(base + '/site/jq');
await pub.waitForSelector('text=Find your stay');
await pub.waitForTimeout(700);
await pub.screenshot({ path: './qa-shots/10-public-site.png', fullPage: true });
console.log('shot: 10-public-site');
await pub.click('button:has-text("Check availability")');
await pub.waitForTimeout(900);
await pub.screenshot({ path: './qa-shots/11-public-availability.png', fullPage: true });
console.log('shot: 11-public-availability');

// Branding: set a brand color + tagline in Settings, save.
await page.click('nav button:has-text("Settings")');
await page.waitForSelector('text=Branding');
await page.evaluate(() => { const c = document.querySelector('input[type="color"]') as HTMLInputElement; if (c) c.value = '#e0533a'; });
await page.fill('input[placeholder="Your beachfront home away from home"]', 'Your island escape on Ilhabela');
await page.click('button:has-text("Save branding")');
await page.waitForTimeout(700);
await shot('12-branding-settings');
// The sidebar accent should now be the brand color.
await page.click('nav button:has-text("Dashboard")');
await page.waitForTimeout(500);
await shot('13-portal-rebranded');
// The public site should reflect the brand (reload it).
await pub.goto(base + '/site/jq');
await pub.waitForSelector('text=Your island escape');
await pub.waitForTimeout(600);
await pub.screenshot({ path: './qa-shots/14-public-branded.png', fullPage: true });
console.log('shot: 14-public-branded');

if (pubErrors.length) errors.push(...pubErrors.map((e) => 'PUBLIC: ' + e));

console.log(errors.length ? `\nCONSOLE ERRORS (${errors.length}):\n` + errors.join('\n') : '\nNO CONSOLE ERRORS');
await browser.close();
server.close();
process.exit(errors.length ? 1 : 0);
