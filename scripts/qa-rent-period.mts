// Browser QA: a student site that quotes per week must actually PRINT "per week"
// on the floorplan and unit cards — with the same figure the operator entered.
import { chromium } from 'playwright-core';
import { readdirSync } from 'node:fs';
import { App, StaticTokenAuthenticator, ConfigStore, RoleRegistry, MasterData, createHttpServer } from '../src/index.ts';

function fc() {
  const r = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  const d = readdirSync(r).find((x) => /^chromium-\d/.test(x))!;
  return `${r}/${d}/chrome-linux/chrome`;
}
const stub = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGOo6qsAIgYIBQAqFgYB3zJ6IgAAAABJRU5ErkJggg==', 'base64');

const auth = new StaticTokenAuthenticator({ o: { actor: 'a', tenantId: 'jq', role: 'owner' } });
const app = new App({ authenticator: auth, config: new ConfigStore(), roles: new RoleRegistry(), masterData: new MasterData() });
const D = (m: string, p: string, b?: Record<string, unknown>) => app.dispatch({ method: m, path: p, bearer: 'Bearer o', body: b ?? {} });
D('PUT', '/config', { displayName: 'Northgate Student Living', country: 'GB', businessStructure: 'student_housing' });
D('POST', '/unit-types', { code: 'ENSUITE', name: 'Classic En-suite', bedrooms: 1, bathrooms: 1, areaSqm: 14, baseRentCents: 17_900 });
D('POST', '/unit-types', { code: 'STUDIO', name: 'Premium Studio', bedrooms: 0, bathrooms: 1, areaSqm: 22, baseRentCents: 24_500 });
D('POST', '/units', { id: 'unit-A101', code: 'A101', label: 'Block A — Room 101', typeId: 'utype-ensuite' });
D('POST', '/units', { id: 'unit-B204', code: 'B204', label: 'Block B — Studio 204', typeId: 'utype-studio' });

const s = createHttpServer(app);
await new Promise<void>((r) => s.listen(0, () => r()));
const port = (s.address() as { port: number }).port;
const b = await chromium.launch({ executablePath: fc(), args: ['--no-sandbox'] });
const errs: string[] = [];
const pg = await (await b.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
pg.on('console', (m) => { if (m.type() === 'error' && !/ERR_|Failed to load resource|fonts\.g/.test(m.text())) errs.push(m.text()); });
pg.on('pageerror', (e) => errs.push('PE:' + e.message));
await pg.route('**fonts.googleapis.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
for (const host of ['**images.unsplash.com/**', '**picsum.photos/**', '**loremflickr.com/**']) {
  await pg.route(host, (r) => r.fulfill({ status: 200, contentType: 'image/png', body: stub }));
}

async function check(period: string, label: string) {
  D('PUT', '/site-content', { content: { rentPeriod: period } });
  await pg.goto(`http://127.0.0.1:${port}/site/jq?template=campushive&demo=1&chrome=0`);
  await pg.waitForFunction(`document.querySelectorAll('#plans .card').length > 0`, { timeout: 20000 });
  await pg.waitForTimeout(500);
  const out = await pg.evaluate(`(() => {
    const txt = (sel) => Array.from(document.querySelectorAll(sel)).map(e => e.textContent.replace(/\\s+/g,' ').trim());
    return { plans: txt('#plans .card .price'), units: txt('#results .card .price') };
  })()`) as { plans: string[]; units: string[] };
  console.log(('quoting ' + label).padEnd(18), '| floorplans:', out.plans.join(' · '), '| units:', out.units.slice(0, 2).join(' · '));
  return out;
}

const weekly = await check('week', 'per week');
await pg.screenshot({ path: '/home/user/Elara/tpl-shots/rent-per-week.png' });
const monthly = await check('month', 'per month');

const weekOk = weekly.plans.every((p) => p.includes('per week')) && weekly.units.every((u) => u.includes('per week'));
const monthOk = monthly.plans.every((p) => p.includes('/ month')) && !monthly.plans.some((p) => p.includes('per week'));
const amount = (t: string) => (t.match(/[\d.,]+/) ?? [''])[0];
const sameFigure = amount(weekly.plans[0]!) === amount(monthly.plans[0]!) && amount(weekly.plans[0]!) !== '';
console.log('weekly site prints "per week" everywhere:', weekOk);
console.log('monthly site prints "/ month", never weekly:', monthOk);
console.log('the figure itself is unchanged by the period:', sameFigure);
console.log(errs.length ? 'ERRORS:' + errs.join('|') : 'NO CONSOLE ERRORS');
await b.close();
s.close();
