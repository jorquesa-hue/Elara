// Tranche 101 — batch-13 mobile bottom tab bar. The tab bar is pure front-end
// (portal.html); this tranche guards that its chrome keys (Home / More labels)
// are translated in all six locales (the tranche-91 discipline — no silent
// English regression).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mergedCatalog } from '../src/i18n.ts';

const KEYS = ['tab.home', 'tab.more', 'nav.menu'];

test('the English catalog defines every mobile tab-bar key', () => {
  const en = mergedCatalog('en');
  const missing = KEYS.filter((k) => !en[k]);
  assert.equal(missing.length, 0, `en is missing: ${missing.join(', ')}`);
});

test('every non-English locale translates the tab-bar keys', () => {
  const en = mergedCatalog('en');
  for (const loc of ['pt-BR', 'es', 'fr', 'it', 'de']) {
    const cat = mergedCatalog(loc);
    const missing = KEYS.filter((k) => !cat[k]);
    assert.equal(missing.length, 0, `${loc} is missing: ${missing.join(', ')}`);
    // The "More" label must actually be translated, not left in English
    // (every one of these five locales has a distinct word for it).
    assert.notEqual(cat['tab.more'], en['tab.more'], `${loc} tab.more should be translated`);
  }
});
