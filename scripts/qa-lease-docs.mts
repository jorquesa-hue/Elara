// Browser-QA the Phase 2B lease-document actions on the agreement detail:
// preview the drafted lease, then draft an e-sign envelope. Asserts NO console errors.
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
md.units.add({ id: 'u-1', tenantId: T, code: 'A-1', label: 'Apt 101', active: true });
const config = new ConfigStore();
config.setupForCountry(T, 'Greyline Living', 'BR', { locale: 'en' });
const app = new App({ authenticator: auth, config, roles: new RoleRegistry(), masterData: md });
const bear = 'Bearer owner-demo';
app.dispatch({ method: 'POST', path: '/agreements', bearer: bear, body: { id: 'ag-1', guestId: 'g-1', unitId: 'u-1', kind: 'lease', start: '2026-08-01', end: '2027-08-01', rateCents: 300000 } });
app.dispatch({ method: 'POST', path: '/agreements/ag-1/activate', bearer: bear, body: {} });
app.dispatch({ method: 'POST', path: '/parties', bearer: bear, body: { id: 'pty-1', kind: 'person', displayName: 'Bea Lima', email: 'bea@x.com' } });
app.dispatch({ method: 'POST', path: '/agreements/ag-1/parties', bearer: bear, body: { partyId: 'pty-1', role: 'resident' } });

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

await page.getByRole('button', { name: 'Agreements' }).click();
await page.waitForTimeout(300);
// Open the agreement detail.
await page.getByRole('button', { name: 'Open' }).first().click();
await page.waitForTimeout(400);

await page.getByRole('button', { name: 'Preview lease' }).click();
await page.waitForTimeout(400);
const previewText = await page.evaluate(() => document.body.innerText);
const hasPreview = /Residential Lease/.test(previewText) && /Lei do Inquilinato/.test(previewText);

await page.getByRole('button', { name: 'Draft e-sign envelope' }).click();
await page.waitForTimeout(400);

// Confirm the envelope now exists via the API (from the browser session).
const hasEnvelope = await page.evaluate(async (tok) => {
  const r = await fetch('/signature-envelopes', { headers: { authorization: 'Bearer ' + tok } });
  const j = await r.json();
  return (j.envelopes || []).some((e: { documentName: string }) => /Apt 101/.test(e.documentName));
}, 'owner-demo');

await page.screenshot({ path: process.argv[2] ?? '/tmp/claude-0/-home-user-Elara/8362700f-e9b3-5f80-9d7c-fe02ed300b4d/scratchpad/lease-docs.png' });
await browser.close();
server.close();

console.log('lease preview rendered:', hasPreview);
console.log('envelope in e-sign list:', hasEnvelope);
console.log('console errors:', errors.length ? errors : 'NONE');
if (errors.length || !hasPreview || !hasEnvelope) process.exit(1);
