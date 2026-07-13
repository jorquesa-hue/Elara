// Browser-QA the Phase 3A resident self-service portal at /resident: sign in as a
// party-scoped resident, see the lease/balance/renewal, submit a maintenance
// request. Asserts NO console errors.
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
const auth = new StaticTokenAuthenticator({
  'owner-demo': { actor: 'ana@demo', tenantId: T, role: 'owner' },
  'res-demo': { actor: 'bea', tenantId: T, role: 'read_only', partyId: 'pty-bea' },
});
const md = new MasterData();
md.units.add({ id: 'u-1', tenantId: T, code: 'A-1', label: 'Apt 101', active: true });
const config = new ConfigStore();
config.setupForCountry(T, 'Greyline Living', 'US');
const app = new App({ authenticator: auth, config, roles: new RoleRegistry(), masterData: md, now: () => NOW });
const bear = 'Bearer owner-demo';
app.dispatch({ method: 'POST', path: '/agreements', bearer: bear, body: { id: 'ag-1', guestId: 'Bea Lima', unitId: 'u-1', kind: 'lease', start: '2025-09-01', end: '2026-09-01', rateCents: 300000 } });
app.dispatch({ method: 'POST', path: '/agreements/ag-1/activate', bearer: bear, body: {} });
app.dispatch({ method: 'POST', path: '/parties', bearer: bear, body: { id: 'pty-bea', kind: 'person', displayName: 'Bea Lima', email: 'bea@x.com' } });
app.dispatch({ method: 'POST', path: '/agreements/ag-1/parties', bearer: bear, body: { partyId: 'pty-bea', role: 'resident' } });
app.dispatch({ method: 'POST', path: '/invoices', bearer: bear, body: { id: 'inv-1', agreementId: 'ag-1', issuedAt: NOW, dueAt: '2026-07-20', lines: [{ description: 'rent', account: 'revenue:room', amountCents: 300000 }] } });
app.dispatch({ method: 'POST', path: '/deposits', bearer: bear, body: { id: 'dep-1', agreementId: 'ag-1', amountCents: 300000 } });
// A lease envelope out for the resident's signature (3D).
app.dispatch({ method: 'POST', path: '/agreements/ag-1/lease-envelope', bearer: bear, body: { id: 'env-1', provider: 'docusign' } });
app.dispatch({ method: 'POST', path: '/signature-envelopes/env-1/send', bearer: bear, body: {} });

const server = createHttpServer(app);
await new Promise<void>((r) => server.listen(0, () => r()));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

const browser = await chromium.launch({ executablePath: findChrome(), args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 900, height: 1000 } })).newPage();
const errors: string[] = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
page.on('response', (r) => { if (r.status() === 404) errors.push('404 ' + r.url()); });
page.on('dialog', (d) => d.accept());

await page.goto(base + '/resident');
await page.evaluate((tok) => localStorage.setItem('usos.res.token', tok), 'res-demo');
await page.reload();
await page.waitForTimeout(600);

const homeText = await page.evaluate(() => document.body.innerText);
const hasHome = /Hi, Bea Lima/.test(homeText) && /Apt 101/.test(homeText) && /Renewal available/.test(homeText);
const hasDocs = /Documents/.test(homeText) && /Awaiting your signature/.test(homeText);

// Submit a maintenance request.
await page.getByPlaceholder('What needs fixing? e.g. Leaky faucet').fill('Leaky faucet');
await page.getByRole('button', { name: 'Submit request' }).click();
await page.waitForTimeout(600);
const afterText = await page.evaluate(() => document.body.innerText);
const requestListed = /Leaky faucet/.test(afterText) && /open/i.test(afterText);

// 3B: view the lease document + signal renewal interest.
await page.getByRole('button', { name: 'View lease' }).click();
await page.waitForTimeout(400);
const docText = await page.evaluate(() => document.body.innerText);
const leaseShown = /Residential Lease/.test(docText);
await page.getByRole('button', { name: "I'd like to renew" }).click();
await page.waitForTimeout(400);
const renewToast = await page.evaluate(() => document.body.innerText);
const renewSignalled = /notified you'd like to renew/.test(renewToast);

// 3C: payments section — the open invoice is listed, and "I've paid this" signals.
const payText = await page.evaluate(() => document.body.innerText);
const invoiceListed = /inv-1/.test(payText) && /All paid up/i.test(payText) === false;
await page.getByRole('button', { name: "I've paid this" }).click();
await page.waitForTimeout(400);
const paidToast = await page.evaluate(() => document.body.innerText);
const paymentSignalled = /reconcile your payment/.test(paidToast);

await page.screenshot({ path: process.argv[2] ?? '/tmp/claude-0/-home-user-Elara/8362700f-e9b3-5f80-9d7c-fe02ed300b4d/scratchpad/resident.png', fullPage: true });
await browser.close();
server.close();

console.log('resident home rendered (lease + renewal):', hasHome);
console.log('documents awaiting signature shown:', hasDocs);
console.log('maintenance request listed:', requestListed);
console.log('lease document shown:', leaseShown);
console.log('renewal interest signalled:', renewSignalled);
console.log('open invoice listed:', invoiceListed);
console.log('payment intent signalled:', paymentSignalled);
console.log('console errors:', errors.length ? errors : 'NONE');
if (errors.length || !hasHome || !hasDocs || !requestListed || !leaseShown || !renewSignalled || !invoiceListed || !paymentSignalled) process.exit(1);
