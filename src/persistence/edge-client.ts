// Caller side of the persist-world Edge Function. The kernel projects state to
// a WorldData; this posts it to the function, which does the FK-ordered write
// inside Supabase (invariant 3 — the trusted boundary owns the write). Zero
// runtime deps: uses the global fetch. The service-role key is supplied by the
// caller's environment and never stored here.
import type { WorldData } from './project.ts';

export interface EdgePersistResult {
  ok: boolean;
  statements: number;
  trialBalance: number;
  counts: Record<string, number>;
}

/** Raised when the function rejects or errors; carries the HTTP status + body. */
export class EdgePersistError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`persist-world failed (${status}): ${JSON.stringify(body)}`);
    this.name = 'EdgePersistError';
  }
}

export interface EdgeClientOptions {
  /** Function base, e.g. https://<ref>.supabase.co/functions/v1 */
  functionsUrl: string;
  /** Service-role JWT — the function requires role=service_role. */
  serviceRoleKey: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * POST a projected world to persist-world. Resolves with the function's report
 * on success (HTTP 200); throws EdgePersistError on any non-200 so callers can
 * branch on status (409 duplicate, 422 constraint/unbalanced, 403 auth, …).
 */
export async function persistWorldViaEdge(
  world: WorldData,
  opts: EdgeClientOptions,
): Promise<EdgePersistResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const url = `${opts.functionsUrl.replace(/\/$/, '')}/persist-world`;
  const res = await doFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.serviceRoleKey}`,
    },
    body: JSON.stringify(world),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !(body as { ok?: boolean })?.ok) {
    throw new EdgePersistError(res.status, body);
  }
  return body as EdgePersistResult;
}
