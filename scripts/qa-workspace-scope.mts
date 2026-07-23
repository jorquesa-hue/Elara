// Browser-QA: (a) student-housing workspace shown+defaulted for a student tenant,
// (b) regional community picker, (c) operator locked-community chip. No console errors.
import { chromium } from 'playwright-core';
import { readdirSync } from 'node:fs';
import { App, StaticTokenAuthenticator, ConfigStore, RoleRegistry, MasterData, createHttpServer } from '../src/index.ts';

function findChrome(): string {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  const dir = readdirSync(root).find((d) => /^chromium-\d/.test(d));
  if (!dir) throw new Error(`no chromium under ${root}`);
  return `${root}/${dir}/chrome-linux/chrome`;
}
const T = 't-mer';
const auth = new StaticTokenAuthenticator({
  'owner-x': { actor: 'ana', tenantId: T, role: 'owner' },                              // regional (no scope)
  'site-x': { actor: 'sam', tenantId: T, role: 'manager', propertyIds: ['prop-a'] },     // scoped operator
});
const config = new ConfigStore();
config.setupForCountry(T, 'Meridian Living', 'GB');
const app = new App({ authenticator: auth, config, roles: new RoleRegistry(), masterData: new MasterData() });
const D = (path: string, body: Record<string, unknown>, tok = 'owner-x') => app.dispatch({ method: 'POST', path, bearer: 'Bearer ' + tok, body });
app.dispatch({ method: 'PUT', path: '/config', bearer: 'Bearer owner-x', body: { businessStructure: 'student_housing' } });
D('/properties', { id: 'prop-a', code: 'BER', name: 'Berlin Campus' });
D('/properties', { id: 'prop-b', code: 'MUC', name: 'Munich Campus' });

const server = createHttpServer(app);
await new Promise<void>((r) => server.listen(0, () => r()));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

const browser = await chromium.launch({ executablePath: findChrome(), args: ['--no-sandbox'] });
const errors: string[] = [];
async function load(token: string) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(base);
  await page.evaluate((t) => localStorage.setItem('usos.token', t), token);
  await page.reload();
  await page.waitForSelector('.topbar', { timeout: 4000 });
  await page.waitForTimeout(500);
  return page;
}

// Regional owner: student workspace default + Roommates in nav + community picker.
const owner = await load('owner-x');
const oText = await owner.evaluate(() => document.body.innerText);
const studentWs = /Student housing/.test(oText);
const roommates = /Roommates/.test(oText);
// The scope control is a <select> with All communities + 2 campuses.
const scopeOpts = await owner.locator('.scopechip select option').count();
await owner.screenshot({ path: '/tmp/claude-0/-home-user-Elara/8362700f-e9b3-5f80-9d7c-fe02ed300b4d/scratchpad/student-ws.png' });

// Scoped operator: a locked community chip (no picker).
const site = await load('site-x');
await site.waitForTimeout(300);
const lockedChip = (await site.locator('.scopechip.locked').count()) > 0;
const chipText = await site.locator('.scopechip.locked').innerText().catch(() => '');

await browser.close();
server.close();

console.log('student workspace:', studentWs, '| Roommates nav:', roommates, '| picker options:', scopeOpts, '| operator locked chip:', lockedChip, '(' + chipText.trim() + ')');
console.log('console errors:', errors.length ? errors : 'NONE');
if (!studentWs || !roommates || scopeOpts !== 3 || !lockedChip || !/Berlin Campus/.test(chipText) || errors.length) process.exit(1);
