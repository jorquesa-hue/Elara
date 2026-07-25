// Browser QA for the student-housing designs. They must NOT look like the
// multifamily set: chunky geometric display type, pill buttons, fat rounded
// cards with a solid offset shadow, a marker swash under section titles, and
// a saturated palette. Measured against a multifamily template as the control.
import { chromium } from 'playwright-core';
import { readdirSync, mkdirSync } from 'node:fs';
import { App, StaticTokenAuthenticator, ConfigStore, RoleRegistry, MasterData, createHttpServer } from '../src/index.ts';

function fc() {
  const r = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  const d = readdirSync(r).find((x) => /^chromium-\d/.test(x))!;
  return `${r}/${d}/chrome-linux/chrome`;
}
mkdirSync('/home/user/Elara/tpl-shots/student', { recursive: true });
const stub = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGOo6qsAIgYIBQAqFgYB3zJ6IgAAAABJRU5ErkJggg==', 'base64');

const auth = new StaticTokenAuthenticator({ o: { actor: 'a', tenantId: 'jq', role: 'owner' } });
const app = new App({ authenticator: auth, config: new ConfigStore(), roles: new RoleRegistry(), masterData: new MasterData() });
app.dispatch({ method: 'PUT', path: '/config', bearer: 'Bearer o', body: { displayName: 'Northgate Student Living', country: 'GB', businessStructure: 'student_housing' } });
app.dispatch({ method: 'POST', path: '/demo/seed', bearer: 'Bearer o', body: {} });
const s = createHttpServer(app);
await new Promise<void>((r) => s.listen(0, () => r()));
const port = (s.address() as { port: number }).port;

const b = await chromium.launch({ executablePath: fc(), args: ['--no-sandbox'] });
const errs: string[] = [];
const pg = await (await b.newContext({ viewport: { width: 1280, height: 940 } })).newPage();
pg.on('console', (m) => { if (m.type() === 'error' && !/ERR_|Failed to load resource|fonts\.g/.test(m.text())) errs.push(m.text()); });
pg.on('pageerror', (e) => errs.push('PE:' + e.message));
await pg.route('**fonts.googleapis.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
await pg.route('**images.unsplash.com/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: stub }));
await pg.route('**picsum.photos/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: stub }));
await pg.route('**loremflickr.com/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: stub }));

const probe = `(() => {
  const btn = document.querySelector('.searchbar .btn');
  const card = document.querySelector('#results .card');
  const h2 = document.querySelector('section > h2');
  const h1 = document.querySelector('h1');
  const cs = (el) => el ? getComputedStyle(el) : null;
  const bs = cs(btn), cd = cs(card), hh = cs(h2), h1s = cs(h1);
  return {
    feel: document.body.getAttribute('data-feel'),
    btnRadius: bs ? parseFloat(bs.borderRadius) : -1,
    cardRadius: cd ? parseFloat(cd.borderTopLeftRadius) : -1,
    cardBorder: cd ? parseFloat(cd.borderTopWidth) : -1,
    cardShadow: cd ? cd.boxShadow.slice(0, 34) : '',
    h1Weight: h1s ? h1s.fontWeight : '',
    h2Weight: hh ? hh.fontWeight : '',
    h2Swash: hh ? hh.backgroundImage !== 'none' : false,
    accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
  };
})()`;

async function shot(tpl: string) {
  await pg.goto(`http://127.0.0.1:${port}/site/jq?template=${tpl}&demo=1&chrome=0`);
  await pg.waitForFunction(`document.body.getAttribute('data-feel') !== null`, { timeout: 20000 });
  await pg.waitForTimeout(900);
  const i = await pg.evaluate(probe) as Record<string, unknown>;
  console.log(tpl.padEnd(12), 'feel=' + String(i.feel).padEnd(10),
    '| btn r=' + i.btnRadius, '| card r=' + i.cardRadius + ' border=' + i.cardBorder,
    '| h1 w=' + i.h1Weight, '| swash=' + i.h2Swash, '| accent=' + i.accent);
  await pg.screenshot({ path: `/home/user/Elara/tpl-shots/student/${tpl}.png` });
  return i;
}

const students = ['campushive', 'freshers', 'hallmates', 'quadnight', 'semester', 'studyloft'];
const results = [];
for (const t of students) results.push(await shot(t));
console.log('--- control (multifamily) ---');
const control = await shot('metropolitan');

const allStudent = results.every((r) => r.feel === 'student');
const pill = results.every((r) => (r.btnRadius as number) >= 99);
const chunky = results.every((r) => Number(r.h1Weight) >= 800);
const fat = results.every((r) => (r.cardRadius as number) >= 20 && (r.cardBorder as number) >= 2);
const swash = results.every((r) => r.h2Swash === true);
const distinct = control.feel !== 'student' && (control.btnRadius as number) < 99 && !control.h2Swash;
console.log('all six read as student feel:', allStudent);
console.log('pill buttons / chunky h1 / fat cards / marker swash:', pill, chunky, fat, swash);
console.log('multifamily control is visibly different:', distinct);
console.log(errs.length ? 'ERRORS:' + errs.join('|') : 'NO CONSOLE ERRORS');
await b.close();
s.close();
