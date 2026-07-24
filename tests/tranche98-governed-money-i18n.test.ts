// Tranche 98 — "governed money" front-end batch (batch 3 of the redesign).
// The portal replaced single-click money actions (record payment, refund
// deposit, pay bill) with confirmation dialogs, replaced the bare prompt()
// calls (exception reject, FCRA application deny) with structured forms, and
// swapped every "(minor)"/"(cents)" money input for a dollars-and-cents field.
// The DOM lives in portal.html (no headless DOM here), so this tranche guards
// the two things a node test CAN prove: (1) every new confirmation/adverse-
// action i18n key is translated in all six locales (no silent English
// regression — the tranche-91 discipline), and (2) the governed endpoints the
// dialogs call still behave: a large deposit refund escalates rather than
// paying out, and denying an application still requires a reason.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';
import { mergedCatalog } from '../src/i18n.ts';

const NOW = '2026-07-24T00:00:00Z';
const own: AuthContext = { actor: 'own', tenantId: 't', role: 'owner' };
const boss: AuthContext = { actor: 'boss', tenantId: 't', role: 'owner' };
const D = (app: App, actor: string, method: string, path: string, body?: Record<string, unknown>) =>
  app.dispatch({ method, path, bearer: 'Bearer ' + actor, body: body ?? {} });

// The keys the batch-3 dialogs look up. If a locale is missing one, the dialog
// renders English in an otherwise-translated portal — the exact regression the
// audit flagged.
const GOVERNED_MONEY_KEYS = [
  'money.invalid', 'action.confirm', 'action.cancel',
  'confirm.payment.title', 'confirm.payment.sub',
  'confirm.refund.title', 'confirm.refund.sub', 'confirm.refund.warn',
  'field.deductionAmount', 'recap.held', 'recap.deductions', 'recap.netrefund', 'recap.payee',
  'confirm.paybill.title', 'confirm.paybill.sub', 'confirm.paybill.warn',
  'confirm.reject.title', 'confirm.reject.sub', 'reject.placeholder', 'btn.reject', 'field.reason',
  'confirm.deny.title', 'confirm.deny.sub', 'field.applicant', 'adverse.reason', 'field.details',
  'adverse.detail', 'adverse.needdetail',
  'adverse.credit', 'adverse.income', 'adverse.eviction', 'adverse.criminal', 'adverse.incomplete', 'adverse.other',
];

test('every governed-money dialog key is translated in all five non-English locales', () => {
  const en = mergedCatalog('en');
  for (const loc of ['pt-BR', 'es', 'fr', 'it', 'de']) {
    const cat = mergedCatalog(loc);
    const missing = GOVERNED_MONEY_KEYS.filter((k) => !cat[k]);
    assert.equal(missing.length, 0, `${loc} is missing: ${missing.join(', ')}`);
    // A representative dialog title must actually be translated, not copied.
    assert.notEqual(cat['confirm.paybill.title'], en['confirm.paybill.title'], `${loc} confirm.paybill.title should be translated`);
  }
});

test('the English catalog defines every governed-money key (dialog fallback base)', () => {
  const en = mergedCatalog('en');
  const missing = GOVERNED_MONEY_KEYS.filter((k) => !en[k]);
  assert.equal(missing.length, 0, `en is missing: ${missing.join(', ')}`);
});

test('a large deposit refund escalates (the confirm dialog cannot pay out unilaterally)', () => {
  const app = new App({ authenticator: new StaticTokenAuthenticator({ own, boss }), units: [], now: () => NOW });
  D(app, 'own', 'PUT', '/config', { displayName: 'M', country: 'BR' });
  D(app, 'own', 'POST', '/units', { code: 'A1', label: 'Apt 1' });
  D(app, 'own', 'POST', '/guests', { code: 'G1', fullName: 'Res' });
  D(app, 'own', 'POST', '/agreements', { id: 'ag1', guestId: 'guest-G1', unitId: 'unit-A1', kind: 'lease', start: '2026-01-01', end: '2027-01-01', rateCents: 100000 });
  // Hold a deposit well over the R$5k escalation threshold, then refund it net.
  D(app, 'own', 'POST', '/deposits', { id: 'dep1', agreementId: 'ag1', amountCents: 900000 });
  const r = D(app, 'own', 'POST', '/deposits/dep1/refund', { deductions: [] });
  assert.equal(r.status, 202, 'a large net refund parks for approval instead of returning cash');
});

test('denying an application still requires an adverse-action reason', () => {
  const app = new App({ authenticator: new StaticTokenAuthenticator({ own }), units: [], now: () => NOW });
  D(app, 'own', 'PUT', '/config', { displayName: 'M', country: 'US' });
  D(app, 'own', 'POST', '/applications', { id: 'app1', applicantName: 'Jamie' });
  const noReason = D(app, 'own', 'POST', '/applications/app1/decide', { decision: 'deny' });
  assert.notEqual(noReason.status, 200, 'deny without a reason is refused');
  const withReason = D(app, 'own', 'POST', '/applications/app1/decide', { decision: 'deny', reason: 'Insufficient credit history / low credit score' });
  assert.equal(withReason.status, 200, 'deny with a documented FCRA reason succeeds');
});
