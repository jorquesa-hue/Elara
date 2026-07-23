// One-off operational helper: force-reseed the demo portfolios on the RUNNING
// app, from INSIDE the Fly machine (where JWT_SECRET lives), so every module is
// populated through the normal kernel path — balanced journals, idempotent
// collision handling, durable flush via the edge. Invoked by the "Seed live"
// workflow with `flyctl ssh console -C "node src/seed-live.mjs"`.
//
// It mints a short-lived owner token off JWT_SECRET (the same HS256 scheme the
// JwtAuthenticator verifies), then POSTs /demo/seed {force:true} for each demo
// variant to the app on localhost. Nothing here touches a credential that isn't
// already in the machine's own environment.
import { createHmac } from 'node:crypto';

const secret = process.env.JWT_SECRET;
if (!secret) { console.error('JWT_SECRET not set in this environment'); process.exit(2); }
const port = process.env.PORT || '8080';
const tenant = process.env.SEED_TENANT || 'jq';
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

function mint() {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url({ alg: 'HS256', typ: 'JWT' });
  const body = b64url({ tenant_id: tenant, user_role: 'owner', sub: 'seed-live-bot', iat: now, exp: now + 600 });
  const data = `${head}.${body}`;
  const sig = createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

const token = mint();

// Fly runs on IPv6; Node's fetch to a bare 127.0.0.1 can miss a server bound on
// :: / ::1. Probe a few hosts once to find the one the app actually answers on.
const hosts = ['localhost', '127.0.0.1', '[::1]'];
async function post(host, payload) {
  return fetch(`http://${host}:${port}/demo/seed`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}
async function findHost() {
  for (let attempt = 0; attempt < 10; attempt++) {
    for (const host of hosts) {
      try {
        const r = await fetch(`http://${host}:${port}/health`, { headers: { authorization: `Bearer ${token}` } });
        console.log(`[probe] ${host} /health -> ${r.status}`);
        return host; // any HTTP response means the socket is reachable
      } catch (e) {
        console.log(`[probe] ${host} -> ${e?.cause?.code || e?.message || e}`);
      }
    }
    await new Promise((res) => setTimeout(res, 1500));
  }
  return null;
}

const host = await findHost();
if (!host) { console.error('no reachable host for the app on port ' + port); process.exit(3); }

const variants = [null, 'europe', 'portfolio'];
let failed = false;
for (const v of variants) {
  const payload = Object.assign({ force: true, at: '2026-07-24T00:00:00Z' }, v ? { variant: v } : {});
  try {
    const r = await post(host, payload);
    const text = await r.text();
    console.log(`[seed ${v || 'brazil'}] ${r.status} ${text.slice(0, 500)}`);
    if (r.status >= 300) failed = true;
  } catch (e) {
    console.error(`[seed ${v || 'brazil'}] ERROR ${e?.cause?.code || e?.message || e}`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
