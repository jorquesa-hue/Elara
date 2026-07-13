// Browser-QA the Phase 2A Applications view: submit → screen → approve/deny,
// asserting NO console errors. Boots the portal in-process against Chromium.
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
const md = new MasterData();
for (const n of ['101', '102']) md.units.add({ id: `u-${n}`, tenantId: T, code: `DEMO-${n}`, label: `Unit ${n}`, active: true });
const config = new ConfigStore();
config.setupForCountry(T, 'Greyline', 'US');
const app = new App({ authenticator: auth, config, roles: new RoleRegistry(), masterData: md });
// A toured lead to link.
app.dispatch({ method: 'POST', path: '/leads', bearer: 'Bearer owner-demo', body: { id: 'ld-1', name: 'Bea Lima', source: 'website', estValueCents: 300000 } });
app.dispatch({ method: 'POST', path: '/leads/ld-1/advance', bearer: 'Bearer owner-demo', body: { stage: 'toured' } });

const server = createHttpServer(app);
await new Promise<void>((r) => server.listen(0, () => r()));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

const browser = await chromium.launch({ executablePath: findChrome(), args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const errors: string[] = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
page.on('requestfailed', (r) => errors.push('REQFAIL ' + r.url()));
page.on('response', (r) => { if (r.status() === 404) errors.push('404 ' + r.url()); });

await page.goto(base);
await page.evaluate((tok) => localStorage.setItem('usos.token', tok), 'owner-demo');
await page.reload();
await page.waitForTimeout(400);

// Navigate to Applications.
await page.getByRole('button', { name: 'Applications' }).click();
await page.waitForTimeout(300);

// Fill the form.
await page.getByPlaceholder('Applicant name').fill('Bea Lima');
await page.getByPlaceholder('applicant@email.com').fill('bea@x.com');
await page.getByPlaceholder('Monthly income (cents)').fill('900000');
await page.getByRole('button', { name: 'Add application' }).click();
await page.waitForTimeout(400);

// Screen then approve.
await page.getByRole('button', { name: 'Screen' }).click();
await page.waitForTimeout(300);
await page.getByRole('button', { name: 'Approve' }).click();
await page.waitForTimeout(400);

const bodyText = await page.evaluate(() => document.body.innerText);
const approved = /approved/i.test(bodyText);

await page.screenshot({ path: process.argv[2] ?? '/tmp/claude-0/-home-user-Elara/8362700f-e9b3-5f80-9d7c-fe02ed300b4d/scratchpad/applications.png' });
await browser.close();
server.close();

console.log('approved row present:', approved);
console.log('console errors:', errors.length ? errors : 'NONE');
if (errors.length || !approved) process.exit(1);
