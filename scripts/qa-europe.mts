// Browser-QA: load the Meridian European sample from the empty-dashboard panel,
// then confirm the portfolio populates (communities + balanced ledger). No errors.
import { chromium } from 'playwright-core';
import { readdirSync } from 'node:fs';
import { App, StaticTokenAuthenticator, ConfigStore, RoleRegistry, MasterData, createHttpServer } from '../src/index.ts';

function findChrome(): string {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  const dir = readdirSync(root).find((d) => /^chromium-\d/.test(d));
  if (!dir) throw new Error(`no chromium under ${root}`);
  return `${root}/${dir}/chrome-linux/chrome`;
}
const T = 't-eu';
const auth = new StaticTokenAuthenticator({ 'own-eu': { actor: 'ana', tenantId: T, role: 'owner' } });
const config = new ConfigStore();
config.setupForCountry(T, 'Meridian Living', 'GB');
const app = new App({ authenticator: auth, config, roles: new RoleRegistry(), masterData: new MasterData() });

const server = createHttpServer(app);
await new Promise<void>((r) => server.listen(0, () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const browser = await chromium.launch({ executablePath: findChrome(), args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 950 } })).newPage();
const errors: string[] = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(base);
await page.evaluate((t) => localStorage.setItem('usos.token', t), 'own-eu');
await page.reload();
await page.waitForTimeout(400);
await page.getByRole('button', { name: 'Import' }).click();            // reachable in every workspace
await page.waitForTimeout(300);
await page.getByRole('button', { name: /Load Europe sample/ }).click({ timeout: 5000 });
await page.waitForTimeout(900);
await page.getByRole('button', { name: 'Communities' }).click().catch(() => {});
await page.waitForTimeout(500);
const text = await page.evaluate(() => document.body.innerText);
const communities = ['Meridian Berlin Mitte', 'Meridian München Schwabing', 'Meridian Amsterdam Zuid', 'Meridian Campus Berlin'].filter((c) => text.includes(c));

await page.screenshot({ path: '/tmp/claude-0/-home-user-Elara/8362700f-e9b3-5f80-9d7c-fe02ed300b4d/scratchpad/europe.png', fullPage: false });

// Confirm the ledger balances after the seed via the API.
const bal = await page.evaluate(async (b) => {
  const r = await fetch(b + '/ledger/trial-balance', { headers: { Authorization: 'Bearer own-eu' } });
  return (await r.json()).balanced;
}, base);

await browser.close();
server.close();

console.log('communities shown:', communities.length, communities, '| ledger balanced:', bal);
console.log('console errors:', errors.length ? errors : 'NONE');
if (communities.length !== 4 || bal !== true || errors.length) process.exit(1);
