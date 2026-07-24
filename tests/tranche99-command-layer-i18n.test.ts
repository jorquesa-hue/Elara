// Tranche 99 — batch-4 "command layer" (Ctrl/⌘-K palette + URL routing). The
// routing + palette are pure front-end (portal.html), but their chrome is
// translated: this tranche guards that every command-palette + batch-3/4 money
// field-label key is present in all six locales (the tranche-91 discipline — no
// silent English regression).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mergedCatalog } from '../src/i18n.ts';

const KEYS = [
  'cmdk.title', 'cmdk.search', 'cmdk.placeholder', 'cmdk.none',
  'cmdk.navigate', 'cmdk.select', 'cmdk.close', 'cmdk.action',
  'cmdk.act.theme', 'cmdk.act.signout', 'cmdk.act.sample', 'cmdk.act.samplehint',
  'field.price', 'field.baserate', 'field.floor', 'field.ceiling',
  'field.estvalue', 'field.income', 'field.budget', 'field.amountsigned',
];

test('the English catalog defines every command-palette + field-label key', () => {
  const en = mergedCatalog('en');
  const missing = KEYS.filter((k) => !en[k]);
  assert.equal(missing.length, 0, `en is missing: ${missing.join(', ')}`);
});

test('every non-English locale translates the command-palette keys', () => {
  const en = mergedCatalog('en');
  for (const loc of ['pt-BR', 'es', 'fr', 'it', 'de']) {
    const cat = mergedCatalog(loc);
    const missing = KEYS.filter((k) => !cat[k]);
    assert.equal(missing.length, 0, `${loc} is missing: ${missing.join(', ')}`);
    // The palette placeholder must actually be translated, not copied.
    assert.notEqual(cat['cmdk.placeholder'], en['cmdk.placeholder'], `${loc} cmdk.placeholder should be translated`);
  }
});
