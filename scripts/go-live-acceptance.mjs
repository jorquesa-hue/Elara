// Go-live acceptance — the one end-to-end check that cannot run from the build
// sandbox (it needs real reachability to the deployed app + Supabase). Run it
// FROM YOUR MACHINE against the deployed app, twice:
//
//   1) seed the probe world and flush it durably:
//        APP_URL=https://<your-app> JWT_SECRET=<supabase jwt secret> \
//          node scripts/go-live-acceptance.mjs seed
//   2) RESTART the app (fly machines restart / redeploy), then verify the world
//      came back from Postgres:
//        APP_URL=... JWT_SECRET=... node scripts/go-live-acceptance.mjs verify
//
// Zero dependencies (node >= 18). It mints its own HS256 owner token for a
// dedicated probe tenant, so nothing here touches real tenant data. JWT_SECRET
// is your Supabase project's JWT secret — the same one the app verifies with.

import { createHmac } from 'node:crypto';

const APP_URL = (process.env.APP_URL ?? '').replace(/\/+$/, '');
const JWT_SECRET = process.env.JWT_SECRET ?? '';
const TENANT = process.env.PROBE_TENANT ?? 'golive-probe';
const phase = process.argv[2];

if (!APP_URL || !JWT_SECRET || !['seed', 'verify'].includes(phase ?? '')) {
  console.error('usage: APP_URL=https://<app> JWT_SECRET=<secret> node scripts/go-live-acceptance.mjs seed|verify');
  process.exit(2);
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
function mintToken() {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    sub: 'go-live-acceptance',
    tenant_id: TENANT,
    user_role: 'owner',
    exp: Math.floor(Date.now() / 1000) + 3600,
  }));
  const sig = createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}
const TOKEN = mintToken();

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok ? '' : detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

async function api(method, path, body) {
  const res = await fetch(APP_URL + path, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body: json };
}

async function seed() {
  console.log(`Seeding probe world for tenant '${TENANT}' at ${APP_URL}\n`);

  const unauth = await fetch(APP_URL + '/health');
  check('unauthenticated request is refused (401)', unauth.status === 401, `got ${unauth.status}`);
  const health = await api('GET', '/health');
  check('authenticated /health is 200 (JWT verifies end-to-end)', health.status === 200, JSON.stringify(health.body));

  const cfg = await api('PUT', '/config', { country: 'BR', displayName: 'Go-live probe' });
  check('tenant configured for BR', cfg.status === 200, JSON.stringify(cfg.body));

  const unit = await api('POST', '/units', { id: 'u-probe', code: 'PROBE-101', label: 'Probe unit' });
  check('unit created', unit.status === 201 || unit.status === 409, JSON.stringify(unit.body));

  const ag = await api('POST', '/agreements', { id: 'agr-probe', unitId: 'u-probe', guestId: 'g-probe', kind: 'monthly', start: '2026-08-01', end: '2026-12-31', rateCents: 250000 });
  check('agreement booked', ag.status === 201 || ag.status === 409, JSON.stringify(ag.body));
  const act = await api('POST', '/agreements/agr-probe/activate', {});
  check('agreement activated', act.status === 200 || act.status === 409, JSON.stringify(act.body));

  const inv = await api('POST', '/invoices', { id: 'inv-probe', agreementId: 'agr-probe', dueAt: '2026-08-10', lines: [{ description: 'Rent', account: 'revenue:room', amountCents: 250000 }] });
  check('invoice issued', inv.status === 201 || inv.status === 409, JSON.stringify(inv.body));
  const pay = await api('POST', '/payments', { id: 'pay-probe', invoiceId: 'inv-probe', amountCents: 250000, method: 'transfer' });
  check('payment recorded', pay.status === 201 || pay.status === 200 || pay.status === 409, JSON.stringify(pay.body));

  const tb = await api('GET', '/ledger/trial-balance');
  check('trial balance balanced after the money steps', tb.status === 200 && tb.body?.balanced === true, JSON.stringify(tb.body));

  const persist = await api('POST', '/persist');
  if (persist.status === 501) {
    check('durable flush', false, 'the app has NO persistence backend (SUPABASE_FUNCTIONS_URL / SUPABASE_SERVICE_ROLE_KEY unset) — verify after restart WILL fail');
  } else {
    check('durable flush through persist-world succeeded', persist.status === 200, JSON.stringify(persist.body));
  }

  console.log(failures === 0
    ? '\nSeed complete. Now RESTART the app, then run the verify phase.'
    : `\nSeed finished with ${failures} failure(s) — fix before restarting.`);
}

async function verify() {
  console.log(`Verifying rehydration for tenant '${TENANT}' at ${APP_URL}\n`);

  const ag = await api('GET', '/agreements/agr-probe');
  check('agreement survived the restart', ag.status === 200 && ag.body?.status === 'active', JSON.stringify(ag.body));
  const inv = await api('GET', '/invoices/inv-probe');
  check('invoice survived, status paid', inv.status === 200 && inv.body?.status === 'paid', JSON.stringify(inv.body));
  const tb = await api('GET', '/ledger/trial-balance');
  const cash = tb.body?.balances?.['assets:cash'];
  check('ledger rehydrated and balanced', tb.status === 200 && tb.body?.balanced === true, JSON.stringify(tb.body));
  check('collected cash is visible (250000)', cash === 250000, `assets:cash = ${cash}`);
  const cfg = await api('GET', '/config');
  check('tenant config (BR) survived', cfg.status === 200 && cfg.body?.config?.country === 'BR', JSON.stringify(cfg.body?.config));

  console.log(failures === 0
    ? '\n✅ GO-LIVE ACCEPTANCE PASSED — boot → write → restart → rehydrate round-trips durably.'
    : `\n❌ ${failures} check(s) failed.`);
}

await (phase === 'seed' ? seed() : verify());
process.exit(failures === 0 ? 0 : 1);
