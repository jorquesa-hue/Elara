// Tranche 91 — i18n coverage: the operator portal, resident SPA and owner SPA
// must not fall back to English where a locale exists. Two guarantees:
//  (1) GET /me carries the tenant's locale, so the party/entity-scoped SPAs
//      (which have no /config access) can fetch the right catalog;
//  (2) every non-English locale defines the view-title, Reports-Center and
//      resident/owner keys the UIs now look up (a missing key silently
//      regressed to English — the exact bug the French screenshot showed).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';
import { mergedCatalog } from '../src/i18n.ts';

const NOW = '2026-07-24T00:00:00Z';
const own: AuthContext = { actor: 'own', tenantId: 't', role: 'owner' };
const D = (app: App, method: string, path: string, body?: Record<string, unknown>) =>
  app.dispatch({ method, path, bearer: 'Bearer own', body: body ?? {} });

test('GET /me carries the tenant locale for the SPA catalog fetch', () => {
  const app = new App({ authenticator: new StaticTokenAuthenticator({ own }), units: [], now: () => NOW });
  D(app, 'PUT', '/config', { displayName: 'M', country: 'BR' }); // BR → pt-BR
  const me = D(app, 'GET', '/me').body as { locale: string };
  assert.equal(me.locale, 'pt-BR', 'BR tenant reports its pt-BR locale on /me');
});

test('every non-English locale defines the newly-referenced UI keys', () => {
  // Keys the operator portal (view titles + Reports Center) and the resident /
  // owner SPAs now look up. If any is missing, the UI shows English instead.
  const keys = [
    // operator portal view titles + Reports Center chrome
    'wsi.maintenance', 'wsi.pipeline', 'wsi.website', 'revenue.title', 'nav.reservations',
    'reports.title', 'reports.sub', 'reptab.insights', 'reptab.catalog', 'period.ytd',
    'period.all', 'repcat.financials', 'repcat.owner', 'sec.branding', 'sec.people', 'login.welcome',
    // resident SPA
    'res.title', 'res.kpi.balance', 'res.pay.confirm', 'res.insurance', 'res.pkg.many', 'res.maintenance',
    // owner SPA
    'own.title', 'own.noi', 'own.dist.note', 'own.capaccount', 'own.communities',
  ];
  for (const loc of ['pt-BR', 'es', 'fr', 'it', 'de']) {
    const cat = mergedCatalog(loc);
    const missing = keys.filter((k) => !cat[k]);
    assert.equal(missing.length, 0, `${loc} is missing: ${missing.join(', ')}`);
    // And the translations must not be byte-identical to English for a sampled
    // key (i.e. actually translated, not copied).
    assert.notEqual(cat['res.title'], mergedCatalog('en')['res.title'], `${loc} res.title should be translated`);
  }
});
