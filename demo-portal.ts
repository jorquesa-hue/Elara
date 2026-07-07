// Runs the operator portal + Public API on node:http with a seeded demo tenant.
//
//   npx tsx demo-portal.ts            # http://localhost:8787
//
// The tenant starts UNCONFIGURED so the setup wizard appears on first load —
// pick a language and currency and watch them flow through the whole app. Four
// demo tokens exercise the access-profiling model at different permission
// levels.

import {
  App,
  StaticTokenAuthenticator,
  ConfigStore,
  RoleRegistry,
  MasterData,
  createHttpServer,
} from './src/index.ts';

const TENANT = 't-demo';

const auth = new StaticTokenAuthenticator({
  'owner-demo': { actor: 'ana@demo', tenantId: TENANT, role: 'owner' },
  'frontdesk-demo': { actor: 'bruno@demo', tenantId: TENANT, role: 'front_desk' },
  'agent-demo': { actor: 'concierge-bot', tenantId: TENANT, role: 'agent' },
  'readonly-demo': { actor: 'auditor@demo', tenantId: TENANT, role: 'read_only' },
});

const config = new ConfigStore(); // left at defaults → wizard shows on first load
const roles = new RoleRegistry();
const masterData = new MasterData();
// Seed a small unit inventory so bookings validate and the subscription meters.
for (const n of ['101', '102', '201']) {
  masterData.units.add({ id: `u-${n}`, tenantId: TENANT, code: `DEMO-${n}`, label: `Unit ${n}`, active: true });
}
masterData.guests.add({ id: 'g-ana', tenantId: TENANT, code: 'G-001', fullName: 'Ana Souza' });

const app = new App({
  authenticator: auth,
  config,
  roles,
  masterData,
  subscriptionPlan: { perUnitCents: 5000, currency: 'USD' },
});

const port = Number(process.env.PORT ?? 8787);
createHttpServer(app).listen(port, () => {
  console.log(`\n  Unified Stay OS portal → http://localhost:${port}\n`);
  console.log('  Demo tokens (paste into the sign-in box):');
  console.log('    owner-demo      — Owner (full control, run setup)');
  console.log('    frontdesk-demo  — Front desk (book/bill/pay, no approvals)');
  console.log('    agent-demo      — AI agent (operational, cannot approve)');
  console.log('    readonly-demo   — Read only (view everything)\n');
});
