// Browser-QA the redesigned Elara login (Supabase password mode). Verifies the
// Elara brand, Meridian Living co-brand, the crafted logos, and NO console errors.
import { chromium } from 'playwright-core';
import { readdirSync } from 'node:fs';
import { App, ConfigStore, RoleRegistry, MasterData, createHttpServer } from '../src/index.ts';

function findChrome(): string {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  const dir = readdirSync(root).find((d) => /^chromium-\d/.test(d));
  if (!dir) throw new Error(`no chromium under ${root}`);
  return `${root}/${dir}/chrome-linux/chrome`;
}

// Supabase auth mode → the redesigned password gate renders.
const app = new App({ config: new ConfigStore(), roles: new RoleRegistry(), masterData: new MasterData(),
  authConfig: { authUrl: 'https://example.supabase.co/auth/v1', anonKey: 'anon-demo' } });
const server = createHttpServer(app);
await new Promise<void>((r) => server.listen(0, () => r()));
const port = (server.address() as { port: number }).port;

const browser = await chromium.launch({ executablePath: findChrome(), args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1000, height: 760 } })).newPage();
const errors: string[] = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(`http://127.0.0.1:${port}`);
await page.waitForSelector('input[type="password"]', { timeout: 4000 }); // password gate resolved
await page.waitForTimeout(200);
const text = await page.evaluate(() => document.body.innerText);
const hasElara = /Elara/.test(text);
const hasOrg = /Meridian Living/.test(text);
const hasWelcome = /welcome back/i.test(text);
const hasLogo = (await page.locator('.elogo svg').count()) > 0 && (await page.locator('.authorg .mlogo svg').count()) > 0;
const hasFields = (await page.locator('input[type="email"]').count()) === 1 && (await page.locator('input[type="password"]').count()) === 1;

const out = process.argv[2] ?? '/tmp/claude-0/-home-user-Elara/8362700f-e9b3-5f80-9d7c-fe02ed300b4d/scratchpad/login.png';
await page.screenshot({ path: out });
// Also grab the light theme.
await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
await page.waitForTimeout(150);
await page.screenshot({ path: out.replace('.png', '-light.png') });

await browser.close();
server.close();

console.log('Elara brand:', hasElara, '| Meridian co-brand:', hasOrg, '| Welcome:', hasWelcome, '| logos:', hasLogo, '| email+password:', hasFields);
console.log('console errors:', errors.length ? errors : 'NONE');
if (!hasElara || !hasOrg || !hasWelcome || !hasLogo || !hasFields || errors.length) process.exit(1);
