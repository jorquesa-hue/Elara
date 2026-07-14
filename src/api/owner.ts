// Loads the self-contained owner/investor SPA (owner.html) once and caches it.
// Like the resident portal, it is zero-dependency vanilla JS/CSS and consumes
// the SAME authenticated Public API (invariant 3) — but every call is entity-
// scoped: an owner token (carrying entityId) reaches only its own portfolio.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let cached: string | null = null;

export function ownerHtml(): string {
  if (cached === null) {
    cached = readFileSync(fileURLToPath(new URL('./owner.html', import.meta.url)), 'utf8');
  }
  return cached;
}
