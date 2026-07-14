// Browser-QA Phase 7B: the owner/investor SPA at /owner — an entity-scoped owner
// token sees their community NOI + distributions. NO console errors.
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
  'owner-op': { actor: 'ana@demo', tenantId: T, role: 'owner' },
  'owner-inv': { actor: 'inv@demo', tenantId: T, role: 'read_only', entityId: 'ent-a' },
});
const config = new ConfigStore();
config.setupForCountry(T, 'Greyline Living', 'US');
const app = new App({ authenticator: auth, config, roles: new RoleRegistry(), masterData: new MasterData(), now: () => NOW });

const D = (method: string, path: string, body: Record<string, unknown>, tok = 'owner-op') => app.dispatch({ method, path, bearer: `Bearer ${tok}`, body });
D('POST', '/legal-entities', { id: 'ent-a', name: 'Northgate SPE LLC', role: 'spe' });
D('POST', '/properties', { id: 'prop-a', code: 'NG', name: 'Northgate', entityId: 'ent-a' });
D('POST', '/units', { id: 'u-a', code: 'A-1', label: 'Apt 101', propertyId: 'prop-a' });
D('POST', '/agreements', { id: 'ag-a', guestId: 'Bea Lima', unitId: 'u-a', kind: 'lease', start: '2026-01-01', end: '2027-01-01', rateCents: 300000 });
D('POST', '/agreements/ag-a/activate', {});
D('POST', '/invoices', { id: 'inv-a', agreementId: 'ag-a', issuedAt: NOW, dueAt: '2026-07-20', lines: [{ description: 'rent', account: 'revenue:room', amountCents: 300000 }] });
D('POST', '/distributions', { id: 'dist-a', entityId: 'ent-a', propertyId: 'prop-a', amountCents: 100000, memo: 'Q2 draw' });

const server = createHttpServer(app);
await new Promise<void>((r) => server.listen(0, () => r()));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

const browser = await chromium.launch({ executablePath: findChrome(), args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1100, height: 900 } })).newPage();
const errors: string[] = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
page.on('response', (r) => { if (r.status() === 404) errors.push('404 ' + r.url()); });

await page.goto(base + '/owner');
await page.evaluate((tok) => localStorage.setItem('usos.own.token', tok), 'owner-inv');
await page.reload();
await page.waitForTimeout(500);
const body = await page.evaluate(() => document.body.innerText);
const ok = /Northgate SPE LLC/.test(body) && /Northgate/.test(body) && /Q2 draw/.test(body) && /Net operating income/i.test(body);

await page.screenshot({ path: process.argv[2] ?? '/tmp/claude-0/-home-user-Elara/8362700f-e9b3-5f80-9d7c-fe02ed300b4d/scratchpad/owner.png' });
await browser.close();
server.close();

console.log('owner portfolio rendered (entity + community + NOI + distribution):', ok);
console.log('console errors:', errors.length ? errors : 'NONE');
if (errors.length || !ok) process.exit(1);
