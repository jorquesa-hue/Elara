// Batch-5 QA: the attention feed on a workspace home is a work-queue — each
// automated insight's CTA is clickable and jumps to the screen where the
// operator fixes it. Seeds an overdue bill (→ a bills_overdue insight), lands on
// the operator home, clicks the insight CTA and asserts it navigated. Fails on
// any console/page error. Screens land in ./wq-shots.
import { chromium } from 'playwright-core';
import { readdirSync, mkdirSync } from 'node:fs';
import { App, StaticTokenAuthenticator, ConfigStore, RoleRegistry, MasterData, createHttpServer } from '../src/index.ts';

const OUT = './wq-shots'; mkdirSync(OUT, { recursive: true });
function findChrome(): string {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  const dir = readdirSync(root).find((d) => /^chromium-\d/.test(d));
  if (!dir) throw new Error(`no chromium under ${root}`);
  return `${root}/${dir}/chrome-linux/chrome`;
}
const T = 't-demo';
const auth = new StaticTokenAuthenticator({ 'owner-demo': { actor: 'ana@demo', tenantId: T, role: 'owner' } });
const md = new MasterData();
md.units.add({ id: 'u-101', tenantId: T, code: 'A-101', label: 'Apt 101', active: true });
const app = new App({ authenticator: auth, config: new ConfigStore(), roles: new RoleRegistry(), masterData: md });
const B = (m: string, p: string, b?: Record<string, unknown>) => app.dispatch({ method: m, path: p, bearer: 'Bearer owner-demo', body: b ?? {} });
B('PUT', '/config', { displayName: 'Meridian', country: 'US' });
B('POST', '/parties', { id: 'p-vendor', kind: 'organization', displayName: 'Acme Plumbing' });
// A bill due well in the past → an overdue-payables insight.
B('POST', '/bills', { id: 'bill-1', payeeId: 'p-vendor', dueAt: '2025-01-01', lines: [{ description: 'Repair', account: 'expenses:supplier', amountCents: 90000 }] });

const server = createHttpServer(app);
await new Promise<void>((r) => server.listen(0, () => r()));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

const browser = await chromium.launch({ executablePath: findChrome(), args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 1100 }, deviceScaleFactor: 2 })).newPage();
const errors: string[] = [];
page.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_RESET|ERR_ABORTED/.test(m.text())) errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
const shot = async (n: string) => { await page.waitForTimeout(200); await page.screenshot({ path: `${OUT}/${n}.png`, fullPage: true }); console.log('shot:', n); };
const fail = (m: string) => { throw new Error(m); };

await page.goto(base);
await page.evaluate(() => localStorage.setItem('usos.token', 'owner-demo'));
await page.reload();
await page.waitForSelector('aside', { timeout: 20000 });
await page.waitForTimeout(800);

// Land on the operator home (its attention feed is unfiltered).
await page.click('.wsswitch summary'); await page.waitForTimeout(150);
await page.click('.wsswitch .wopt:has-text("Property operator")'); await page.waitForTimeout(900);
await shot('01-operator-home');

const cta = page.locator('.insight-cta').first();
const n = await cta.count();
console.log('clickable insight CTAs on the home:', n);
if (!n) fail('no clickable insight CTA rendered — the feed is not a work-queue');
const label = (await cta.textContent()) || '';
console.log('first CTA:', JSON.stringify(label.trim()));
const beforeHash = await page.evaluate(() => location.hash);
await cta.click();
await page.waitForTimeout(600);
const afterHash = await page.evaluate(() => location.hash);
const h1 = await page.locator('main h1').first().textContent();
console.log('CTA jumped from', beforeHash, 'to', afterHash, '— h1:', h1);
if (afterHash === beforeHash) fail('insight CTA did not navigate');
await shot('02-after-cta');

if (errors.length) { console.error('CONSOLE/PAGE ERRORS:\n' + errors.join('\n')); }
else { console.log('NO CONSOLE ERRORS'); }
await browser.close(); server.close();
process.exit(errors.length ? 1 : 0);
