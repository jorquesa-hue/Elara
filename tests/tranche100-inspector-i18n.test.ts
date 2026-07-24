// Tranche 100 — batch-6 split-view inspector on the agreements list (from the
// Pro-Console concept). The inspector is pure front-end (portal.html); this
// tranche guards that its chrome keys are translated in all six locales (the
// tranche-91 discipline — no silent English regression).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mergedCatalog } from '../src/i18n.ts';

const KEYS = ['agreements.inspecthint', 'insp.pick', 'insp.deposit', 'insp.activity', 'insp.openfull', 'msg.loading'];

test('the English catalog defines every inspector key', () => {
  const en = mergedCatalog('en');
  const missing = KEYS.filter((k) => !en[k]);
  assert.equal(missing.length, 0, `en is missing: ${missing.join(', ')}`);
});

test('every non-English locale translates the inspector keys', () => {
  const en = mergedCatalog('en');
  for (const loc of ['pt-BR', 'es', 'fr', 'it', 'de']) {
    const cat = mergedCatalog(loc);
    const missing = KEYS.filter((k) => !cat[k]);
    assert.equal(missing.length, 0, `${loc} is missing: ${missing.join(', ')}`);
    assert.notEqual(cat['insp.openfull'], en['insp.openfull'], `${loc} insp.openfull should be translated`);
  }
});
