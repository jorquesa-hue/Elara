// Batch-3 QA: minimal fast tenant with exactly one payable bill + one open
// application, so the new confirmation dialogs + money field are guaranteed
// present. Opens each dialog, checks the money echo / FCRA options render, and
// fails on any console/page error. Screens land in ./gm-shots.
import { chromium } from 'playwright-core';
import { readdirSync, mkdirSync } from 'node:fs';
import { App, StaticTokenAuthenticator, ConfigStore, RoleRegistry, MasterData, createHttpServer } from '../src/index.ts';

const OUT = './gm-shots'; mkdirSync(OUT, { recursive: true });
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
md.guests.add({ id: 'g-1', tenantId: T, code: 'G-1', fullName: 'Ana Souza' });
const app = new App({ authenticator: auth, config: new ConfigStore(), roles: new RoleRegistry(), masterData: md });
const B = (method: string, path: string, body?: Record<string, unknown>) => app.dispatch({ method, path, bearer: 'Bearer owner-demo', body: body ?? {} });
B('PUT', '/config', { displayName: 'Meridian', country: 'US' });
// A payable bill (vendor payee).
B('POST', '/parties', { id: 'p-vendor', kind: 'organization', displayName: 'Acme Plumbing' });
console.log('bill:', B('POST', '/bills', { id: 'bill-1', payeeId: 'p-vendor', dueAt: '2026-08-01', lines: [{ description: 'Repair', account: 'expense:maintenance', amountCents: 45000 }] }).status);
// An open application to deny.
console.log('app:', B('POST', '/applications', { id: 'app-1', applicantName: 'Jamie Rivera', applicantEmail: 'j@x.com', incomeCents: 300000 }).status);

const server = createHttpServer(app);
await new Promise<void>((r) => server.listen(0, () => r()));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

const browser = await chromium.launch({ executablePath: findChrome(), args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 1200 }, deviceScaleFactor: 2 })).newPage();
const errors: string[] = [];
page.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_RESET|ERR_ABORTED/.test(m.text())) errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
const shot = async (n: string) => { await page.waitForTimeout(200); await page.screenshot({ path: `${OUT}/${n}.png`, fullPage: true }); console.log('shot:', n); };

await page.goto(base);
await page.evaluate(() => localStorage.setItem('usos.token', 'owner-demo'));
await page.reload();
await page.waitForSelector('aside', { timeout: 20000 });
await page.waitForTimeout(800);
await shot('01-home');

async function switchWorkspace(name: string) {
  await page.click('.wsswitch summary');            // open the details
  await page.waitForTimeout(200);
  await page.click('.wsswitch .wopt:has-text("' + name + '")');
  await page.waitForTimeout(500);
}
async function navTo(label: string) {
  await page.click('nav button.item:has-text("' + label + '")');
  await page.waitForTimeout(800);
}

// --- Bills → pay-bill dialog ---
await switchWorkspace('Finance');
await navTo('Bills');
console.log('bills view h1:', await page.locator('main h1').first().textContent().catch(() => '?'));
const payBtn = page.locator('button:has-text("Pay outstanding")').first();
if (!(await payBtn.count())) throw new Error('expected a payable bill');
await payBtn.click();
await page.waitForSelector('.modal', { timeout: 5000 });
const echo = (await page.locator('.modal .money-echo').first().textContent().catch(() => '')) || '';
console.log('pay-bill money echo:', JSON.stringify(echo));
if (!/\$/.test(echo)) throw new Error('money echo not formatted: ' + echo);
await shot('02-paybill-dialog');
await page.keyboard.press('Escape').catch(() => {}); await page.waitForTimeout(200);
await page.waitForTimeout(200);

// --- Applications → FCRA deny dialog ---
await switchWorkspace('Sales');
await navTo('Applications');
const denyBtn = page.locator('button:has-text("Deny")').first();
if (!(await denyBtn.count())) throw new Error('expected an open application');
await denyBtn.click();
await page.waitForSelector('.modal .radioset', { timeout: 5000 });
const radios = await page.locator('.modal .radioset label').count();
console.log('FCRA adverse-reason options:', radios);
if (radios < 5) throw new Error('expected FCRA reason presets');
await shot('03-deny-fcra-dialog');
await page.keyboard.press('Escape').catch(() => {}); await page.waitForTimeout(200);

if (errors.length) { console.error('CONSOLE/PAGE ERRORS:\n' + errors.join('\n')); }
else { console.log('NO CONSOLE ERRORS'); }
await browser.close(); server.close();
process.exit(errors.length ? 1 : 0);
