// Loads the self-contained resident self-service SPA (resident.html) once and
// caches it. Like the operator portal, it is zero-dependency vanilla JS/CSS and
// consumes the SAME authenticated Public API (invariant 3) — but every call is
// party-scoped: a resident token (carrying partyId) reaches only its own data.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let cached: string | null = null;

export function residentHtml(): string {
  if (cached === null) {
    cached = readFileSync(fileURLToPath(new URL('./resident.html', import.meta.url)), 'utf8');
  }
  return cached;
}
