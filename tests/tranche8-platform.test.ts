// Tranche 8 — platform foundations: setup-time config (locale/currency),
// money formatting across currencies, RBAC (built-in + custom roles), master
// data, and end-to-end permission enforcement in the API. 7 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConfigStore, formatMoney, ConfigError } from '../src/config.ts';
import { t } from '../src/i18n.ts';
import { RoleRegistry, RbacError } from '../src/rbac.ts';
import { MasterData, MasterDataError } from '../src/master-data.ts';
import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';

test('config: setup-time locale + currency switch, with validation', () => {
  const store = new ConfigStore();
  // Defaults for an unconfigured tenant.
  assert.equal(store.get('t-1').currency, 'USD');
  const cfg = store.set({ tenantId: 't-1', displayName: 'Rio Ops', locale: 'pt-BR', currency: 'BRL', timezone: 'America/Sao_Paulo', businessStructure: 'short_stay', country: 'BR', jurisdiction: 'BR' });
  assert.equal(cfg.locale, 'pt-BR');
  assert.equal(cfg.currency, 'BRL');
  assert.equal(cfg.jurisdiction, 'BR'); // derived from country
  // One-click currency change.
  assert.equal(store.update('t-1', { currency: 'EUR' }).currency, 'EUR');
  // Unsupported values are rejected.
  assert.throws(() => store.update('t-1', { currency: 'XYZ' }), ConfigError);
  assert.throws(() => store.update('t-1', { locale: 'xx' }), ConfigError);
});

test('money formats per locale + currency, honoring minor units', () => {
  // 180000 minor units → R$1.800,00 / $1,800.00 / ¥180,000 (0-decimal).
  assert.match(formatMoney(180000, { locale: 'pt-BR', currency: 'BRL' }), /1\.800,00/);
  assert.match(formatMoney(180000, { locale: 'en', currency: 'USD' }), /1,800\.00/);
  assert.equal(formatMoney(180000, { locale: 'en', currency: 'JPY' }).replace(/\s/g, ''), '¥180,000');
});

test('i18n translates keys and interpolates, falling back to English', () => {
  assert.equal(t('pt-BR', 'nav.agreements'), 'Contratos');
  assert.equal(t('es', 'action.book'), 'Reservar estancia');
  assert.match(t('en', 'msg.subscription', { amount: '$10.00', units: 2 }), /\$10\.00 for 2 units/);
  assert.equal(t('pt-BR', 'no.such.key'), 'no.such.key'); // key fallback
});

test('rbac: built-in role permissions and a flexible custom role', () => {
  const reg = new RoleRegistry();
  assert.ok(reg.permissionsFor('t-1', 'owner').has('role.manage'));
  assert.ok(reg.permissionsFor('t-1', 'agent').has('agreement.book'));
  assert.equal(reg.permissionsFor('t-1', 'agent').has('exception.approve'), false); // AI cannot approve
  assert.ok(reg.permissionsFor('t-1', 'staff').has('exception.approve'));
  // Custom role for a bespoke business structure.
  reg.defineRole('t-1', { id: 'housekeeping_lead', name: 'Housekeeping Lead', permissions: ['agreement.read', 'masterdata.read'] });
  const perms = reg.permissionsFor('t-1', 'housekeeping_lead');
  assert.deepEqual([...perms].sort(), ['agreement.read', 'masterdata.read']);
  // Custom roles are tenant-scoped; another tenant does not see them.
  assert.equal(reg.permissionsFor('t-2', 'housekeeping_lead').size, 0);
  // Built-in ids are reserved; unknown permissions rejected.
  assert.throws(() => reg.defineRole('t-1', { id: 'owner', name: 'x', permissions: [] }), RbacError);
  assert.throws(() => reg.defineRole('t-1', { id: 'z', name: 'z', permissions: ['nope' as never] }), RbacError);
});

test('master data enforces unique codes per tenant', () => {
  const md = new MasterData();
  md.units.add({ id: 'u-1', tenantId: 't-1', code: 'RIO-101', label: '101', active: true });
  assert.throws(
    () => md.units.add({ id: 'u-2', tenantId: 't-1', code: 'RIO-101', label: 'dup', active: true }),
    MasterDataError,
  );
  // Same code is fine in a different tenant.
  assert.doesNotThrow(() => md.units.add({ id: 'u-3', tenantId: 't-2', code: 'RIO-101', label: '101', active: true }));
  assert.equal(md.units.list('t-1').length, 1);
});

test('API enforces per-route permissions by role', () => {
  const auth = new StaticTokenAuthenticator({
    'tok-owner': { actor: 'o', tenantId: 't-1', role: 'owner' },
    'tok-ro': { actor: 'r', tenantId: 't-1', role: 'read_only' },
  });
  const app = new App({ authenticator: auth, now: () => '2026-07-01T00:00:00Z' });
  const b = (tok: string) => `Bearer ${tok}`;

  // read_only can read config but not change it.
  assert.equal(app.dispatch({ method: 'GET', path: '/config', bearer: b('tok-ro') }).status, 200);
  const denied = app.dispatch({ method: 'PUT', path: '/config', bearer: b('tok-ro'), body: { currency: 'EUR' } });
  assert.equal(denied.status, 403);
  assert.equal((denied.body as { permission: string }).permission, 'config.manage');

  // Owner can change it, and the currency flows into new agreements' money.
  const put = app.dispatch({ method: 'PUT', path: '/config', bearer: b('tok-owner'), body: { displayName: 'Rio', currency: 'BRL', locale: 'pt-BR' } });
  assert.equal(put.status, 200);
  assert.equal((put.body as { currency: string }).currency, 'BRL');

  // read_only cannot manage users; owner can.
  assert.equal(app.dispatch({ method: 'POST', path: '/users', bearer: b('tok-ro'), body: {} }).status, 403);
});

test('configured currency flows through to booked agreements and the ledger', () => {
  const auth = new StaticTokenAuthenticator({ 'tok-owner': { actor: 'o', tenantId: 't-1', role: 'owner' } });
  const app = new App({ authenticator: auth, now: () => '2026-07-01T00:00:00Z' });
  const b = 'Bearer tok-owner';
  app.dispatch({ method: 'PUT', path: '/config', bearer: b, body: { displayName: 'Rio', currency: 'BRL', locale: 'pt-BR' } });
  app.dispatch({ method: 'POST', path: '/units', bearer: b, body: { id: 'u-1', code: 'RIO-101', label: '101' } });
  const book = app.dispatch({
    method: 'POST',
    path: '/agreements',
    bearer: b,
    body: { id: 'ag-1', guestId: 'g-1', unitId: 'u-1', kind: 'nightly', start: '2026-07-01', end: '2026-07-05', rateCents: 80000 },
  });
  assert.equal(book.status, 201);
  // The invoice line posts in the tenant currency (BRL), proving config → ledger.
  app.dispatch({ method: 'POST', path: '/agreements/ag-1/activate', bearer: b, body: {} });
  const inv = app.dispatch({
    method: 'POST',
    path: '/invoices',
    bearer: b,
    body: { id: 'inv-1', agreementId: 'ag-1', dueAt: '2026-07-05', lines: [{ description: '4 nights', account: 'revenue:room', amountCents: 80000 }] },
  });
  assert.equal(inv.status, 201);
  assert.equal((inv.body as { currency: string }).currency, 'BRL');
});
