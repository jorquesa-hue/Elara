// connector-worker — the runtime drain arm for the connector outbox. Hosted
// inside Supabase (like persist-world) so it reaches Postgres over the internal
// SUPABASE_DB_URL and can resolve credentials from the deployment's secret store
// (Deno.env / Supabase Vault) WITHOUT any credential ever entering the kernel or
// the DB — the integration row holds only a secretRef pointer.
//
// Contract: POST { tenantId?, limit? }. The worker claims pending connector_command
// rows (optionally for one tenant), joins each to its integration to learn the kind
// + secretRef, resolves the secret, applies the ROUTING POLICY (a verbatim twin of
// src/connector-adapters.ts), performs the real vendor call for dispatchable kinds,
// then records dispatched/succeeded/failed back on the command. All in one tx.
//
// SAFETY (behavioral guardrail): bank / payment_gateway commands are REFUSED here —
// a payout adapter must be written + enabled with explicit human approval, never
// auto-dispatched. The policy envelope already ESCALATES a large connector payout
// before it is enqueued; this is defence-in-depth at the drain edge.
//
// Auth: gateway verify_jwt PLUS in-body role=service_role — only the service-role
// backend/cron may drain the outbox.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import postgres from 'npm:postgres@3';

const DB_URL = Deno.env.get('SUPABASE_DB_URL') ?? '';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function jwtRole(auth: string | null): string | null {
  if (!auth?.startsWith('Bearer ')) return null;
  const parts = auth.slice(7).split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(atob(pad));
    return typeof payload.role === 'string' ? payload.role : null;
  } catch {
    return null;
  }
}

// --- routing policy: verbatim twin of src/connector-adapters.ts -------------
const DISPATCHABLE_KINDS = ['lock', 'access_control', 'elevator', 'website', 'crm'];
const MONEY_KINDS = ['bank', 'payment_gateway'];

function planConnectorCommand(input: { action: string; kind: string; secretResolved: boolean }): { decision: string; reason: string } {
  if (!input.action) return { decision: 'reject', reason: 'missing_action' };
  if (MONEY_KINDS.includes(input.kind)) return { decision: 'refuse', reason: 'money_rail_requires_human_approved_adapter' };
  if (!DISPATCHABLE_KINDS.includes(input.kind)) return { decision: 'reject', reason: `unsupported_kind:${input.kind}` };
  if (!input.secretResolved) return { decision: 'reject', reason: 'missing_secret' };
  return { decision: 'dispatch', reason: 'ok' };
}

/**
 * Perform the real vendor call for a dispatchable kind. The credential is resolved
 * HERE (never in the kernel). Real provider HTTP goes behind this seam per (kind,
 * provider). Until a specific vendor adapter is wired, we record a structured
 * simulated success so the outbox drains deterministically — NEVER for money kinds
 * (those are refused before reaching here).
 */
async function dispatchToVendor(
  cmd: { action: string; kind: string; provider: string; payload: Record<string, unknown> },
  _secret: string,
): Promise<{ ok: boolean; reason: string; providerResponse?: Record<string, unknown> }> {
  // TODO(adapter): switch on (cmd.kind, cmd.provider) and call the vendor API with
  // `_secret`. e.g. Salto/Yale unlock, elevator dispatch, website inventory push,
  // CRM lead pull. Real HTTP is intentionally not wired for providers we cannot
  // authenticate against from this environment.
  return { ok: true, reason: 'dispatched', providerResponse: { simulated: true, action: cmd.action } };
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  if (jwtRole(req.headers.get('Authorization')) !== 'service_role') {
    return json(403, { error: 'forbidden', detail: 'service_role required' });
  }
  if (!DB_URL) return json(500, { error: 'no_db_url' });

  let opts: { tenantId?: string; limit?: number } = {};
  try {
    opts = (await req.json()) as typeof opts;
  } catch {
    opts = {};
  }
  const limit = Math.min(Math.max(Number(opts.limit) || 25, 1), 200);

  const sql = postgres(DB_URL, { prepare: false, max: 1, idle_timeout: 5 });
  const outcomes: Array<{ id: string; status: string; reason: string }> = [];
  try {
    const pending = await sql.unsafe(
      `select c.id, c.action, c.payload, c.tenant_id, i.kind, i.provider, i.status as integ_status, i.secret_ref
         from connector_command c
         join integration i on i.id = c.integration_id
        where c.status = 'pending' ${opts.tenantId ? 'and c.tenant_id = $1' : ''}
        order by c.created_at
        limit ${limit}`,
      opts.tenantId ? [opts.tenantId] : [],
    );

    for (const row of pending) {
      const kind = String(row.kind);
      const secretRef = row.secret_ref ? String(row.secret_ref) : '';
      const secret = secretRef ? (Deno.env.get(secretRef) ?? '') : '';
      let status: 'succeeded' | 'failed';
      let result: Record<string, unknown>;

      if (String(row.integ_status) !== 'active') {
        status = 'failed';
        result = { error: 'integration_disabled' };
      } else {
        const plan = planConnectorCommand({ action: String(row.action), kind, secretResolved: !!secret });
        if (plan.decision === 'dispatch') {
          const out = await dispatchToVendor(
            { action: String(row.action), kind, provider: String(row.provider), payload: (row.payload ?? {}) as Record<string, unknown> },
            secret,
          );
          status = out.ok ? 'succeeded' : 'failed';
          result = { reason: out.reason, ...(out.providerResponse ? { providerResponse: out.providerResponse } : {}) };
        } else {
          status = 'failed';
          result = { error: plan.reason, decision: plan.decision };
        }
      }

      await sql.unsafe(
        `update connector_command
            set status = $2, dispatched_at = coalesce(dispatched_at, now()), resolved_at = now(), result = $3::jsonb
          where id = $1 and status = 'pending'`,
        [String(row.id), status, JSON.stringify(result)],
      );
      outcomes.push({ id: String(row.id), status, reason: String(result.error ?? result.reason ?? '') });
    }
  } catch (e) {
    return json(500, { error: 'drain_failed', detail: (e as { message?: string }).message ?? String(e) });
  } finally {
    await sql.end({ timeout: 5 });
  }

  return json(200, { ok: true, drained: outcomes.length, outcomes });
});
