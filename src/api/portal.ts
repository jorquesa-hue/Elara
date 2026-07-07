// Loads the self-contained operator portal SPA (portal.html) once and caches it.
// The SPA is zero-dependency vanilla JS/CSS — no build step — and consumes the
// Public API (invariant 3): the same authenticated surface agents use.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let cached: string | null = null;

export function portalHtml(): string {
  if (cached === null) {
    cached = readFileSync(fileURLToPath(new URL('./portal.html', import.meta.url)), 'utf8');
  }
  return cached;
}
