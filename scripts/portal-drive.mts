// Browser-drives the operator portal to catch UI issues the API tests can't and
// to capture screenshots. Boots the seeded portal in-process, then walks the
// flows with playwright-core against the preinstalled Chromium.
//   npx tsx scripts/portal-drive.mts <outDir>
import { chromium } from 'playwright-core';
import { readdirSync } from 'node:fs';
import {
  App, StaticTokenAuthenticator, ConfigStore, RoleRegistry, MasterData, createHttpServer,
} from '../src/index.ts';

const OUT = process.argv[2] ?? '.';
// Resolve the preinstalled Chromium under PLAYWRIGHT_BROWSERS_PATH.
function findChrome(): string {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  const dir = readdirSync(root).find((d) => /^chromium-\d/.test(d));
  if (!dir) throw new Error(`no chromium under ${root}`);
  return `${root}/${dir}/chrome-linux/chrome`;
}
const CHROME = findChrome();
const T = 't-demo';

const auth = new StaticTokenAuthenticator({
  'owner-demo': { actor: 'ana@demo', tenantId: T, role: 'owner' },
  'readonly-demo': { actor: 'auditor@demo', tenantId: T, role: 'read_only' },
});
const md = new MasterData();
for (const n of ['101', '102', '201']) md.units.add({ id: `u-${n}`, tenantId: T, code: `DEMO-${n}`, label: `Unit ${n}`, active: true });
md.guests.add({ id: 'g-ana', tenantId: T, code: 'G-001', fullName: 'Ana Souza' });
const app = new App({ authenticator: auth, config: new ConfigStore(), roles: new RoleRegistry(), masterData: md, subscriptionPlan: { perUnitCents: 5000, currency: 'USD' } });

const server = createHttpServer(app);
await new Promise<void>((r) => server.listen(0, () => r()));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const errors: string[] = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

async function shot(name: string) {
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  console.log('shot:', name);
}

// Sign in as owner (unconfigured tenant → wizard).
await page.goto(base);
await page.evaluate(() => localStorage.setItem('usos.token', 'owner-demo'));
await page.reload();
await page.waitForSelector('text=Set up your workspace');
await shot('01-setup-wizard');

// Complete setup in English + USD.
await page.fill('input', 'Copacabana Stays'); // first input = workspace name
await page.click('text=Finish setup');
await page.waitForSelector('text=Dashboard');
await shot('02-dashboard');

// Light theme.
await page.click('button[title="Theme"]');
await page.waitForTimeout(250);
await shot('02b-dashboard-light');
await page.click('button[title="Theme"]'); // back to dark

// Agreements: book a stay.
await page.click('button:has-text("Agreements")');
await page.waitForSelector('text=Book a stay');
await page.click('button:has-text("Book a stay")');
await page.waitForTimeout(300);
await shot('03-agreements-booked');

// Activate then convert via row actions.
const activate = page.locator('button:has-text("Activate")').first();
if (await activate.count()) { await activate.click(); await page.waitForTimeout(300); }
await shot('04-agreements-active');

// Open the agreement detail and run the billing lifecycle.
await page.click('button:has-text("Open")');
await page.waitForSelector('text=Event history');
await page.click('button:has-text("Issue invoice")');
await page.waitForTimeout(450);
await page.click('button:has-text("Record payment")');
await page.waitForTimeout(450);
await page.click('button:has-text("Hold deposit")');
await page.waitForTimeout(450);
// Phase 1: assign a payer party in the People section, then adjust the rent.
await page.fill('input[placeholder="Full name"]', 'Parent Payer');
await page.click('button:has-text("Assign")');
await page.waitForTimeout(450);
await page.click('button:has-text("Adjust rent")');
await page.waitForTimeout(450);
await shot('04c-agreement-detail');
await page.click('button:has-text("Back")');
await page.waitForTimeout(250);

// Phase 1: accounts payable — record a vendor bill against the payee, then pay it.
await page.click('button:has-text("Bills")');
await page.waitForSelector('text=Accounts payable');
await page.click('button:has-text("Record bill")');
await page.waitForTimeout(450);
const payBtn = page.locator('button:has-text("Pay")').first();
if (await payBtn.count()) { await payBtn.click(); await page.waitForTimeout(400); }
await shot('09-bills-ap');

// Phase 2: maintenance — raise a work order, then start it.
await page.click('button:has-text("Maintenance")');
await page.waitForSelector('text=Work orders on your spaces');
await page.fill('input[placeholder="Leaky faucet"]', 'Fix rooftop leak');
await page.click('button:has-text("Raise work order")');
await page.waitForTimeout(450);
const startBtn = page.locator('button:has-text("Start")').first();
if (await startBtn.count()) { await startBtn.click(); await page.waitForTimeout(400); }
await shot('10-maintenance');

// Phase 2: reservations — the demo tenant has no common space, so just confirm
// the view renders its empty state without errors.
await page.click('button:has-text("Reservations")');
await page.waitForSelector('text=Book common areas and amenities');
await shot('11-reservations');

// Phase 2 wire-up: Inbox — open a thread and send a message.
await page.click('button:has-text("Inbox")');
await page.waitForSelector('text=Resident, finance, and internal conversations');
await page.fill('input[placeholder="Subject"]', 'Front desk question');
await page.click('button:has-text("Open thread")');
await page.waitForTimeout(400);
const threadLink = page.locator('button:has-text("Front desk question")').first();
if (await threadLink.count()) {
  await threadLink.click();
  await page.waitForSelector('text=Conversation');
  await page.fill('input[placeholder="Type a reply…"]', 'How can I help?');
  await page.click('button:has-text("Send")');
  await page.waitForTimeout(400);
}
await shot('12-inbox');

// Phase 2 wire-up: Reconcile — import a bank line.
await page.click('button:has-text("Reconcile")');
await page.waitForSelector('text=Import bank lines and match them');
await page.click('button:has-text("Import line")');
await page.waitForTimeout(400);
await shot('13-reconcile');

// Ledger.
await page.click('button:has-text("Ledger")');
await page.waitForTimeout(300);
await shot('05-ledger');

// People (users & roles).
await page.click('button:has-text("Users")');
await page.waitForTimeout(300);
await shot('06-people');

// Settings → switch language to Português.
await page.click('button:has-text("Settings")');
await page.waitForTimeout(200);
await page.selectOption('select >> nth=0', 'pt-BR'); // language select
await page.selectOption('select >> nth=1', 'BRL'); // currency select
await page.click('button:has-text("Save")');
await page.waitForTimeout(400);
await page.click('button:has-text("Painel")'); // dashboard in pt-BR
await page.waitForTimeout(300);
await shot('07-dashboard-ptBR-BRL');

// Read-only role: book form and admin should be gone.
await page.evaluate(() => localStorage.setItem('usos.token', 'readonly-demo'));
await page.reload();
await page.waitForTimeout(400);
await page.click('button:has-text("Contratos"), button:has-text("Agreements")');
await page.waitForTimeout(300);
await shot('08-readonly-agreements');

console.log(errors.length ? 'CONSOLE ERRORS:\n' + errors.join('\n') : 'NO CONSOLE ERRORS');
await browser.close();
server.close();
