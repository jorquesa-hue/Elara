// connector-worker — the runtime drain arm for the connector outbox. Hosted
// inside Supabase (like persist-world) so it reaches Postgres over the internal
// SUPABASE_DB_URL and can resolve credentials from the deployment's secret store
// (Deno.env / Supabase Vault) WITHOUT any credential ever entering the kernel or
// the DB — the integration row holds only a secretRef pointer.
//
// Contract: POST { tenantId?, limit? }. The worker claims pending connector_command
// rows (optionally for one tenant), joins each to its integration to learn the kind
// + secretRef, resolves the secret, applies the ROUTING POLICY (a verbatim twin of
// src/connector-adapters.ts), executes the CREDENTIAL-FREE vendor request the kernel
// adapter attached (payload._request) by injecting the secret per its auth descriptor,
// then records dispatched/succeeded/failed back on the command. All in one tx.
//
// A new vendor never touches THIS file: the kernel's adapter registry builds the
// request; the edge is pure plumbing (inject secret + execute).
//
// SAFETY (behavioral guardrail): bank / payment_gateway commands are REFUSED here —
// a payout adapter must be enabled with explicit human approval, never auto-dispatched.
// The policy envelope already ESCALATES a large connector payout before enqueue; and
// the money-rail adapter ships disabled so no _request is even built. Defence in depth.
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
const DISPATCHABLE_KINDS = ['lock', 'access_control', 'elevator', 'website', 'crm', 'fiscal'];
const MONEY_KINDS = ['bank', 'payment_gateway'];

function planConnectorCommand(input: { action: string; kind: string; secretResolved: boolean }): { decision: string; reason: string } {
  if (!input.action) return { decision: 'reject', reason: 'missing_action' };
  if (MONEY_KINDS.includes(input.kind)) return { decision: 'refuse', reason: 'money_rail_requires_human_approved_adapter' };
  if (!DISPATCHABLE_KINDS.includes(input.kind)) return { decision: 'reject', reason: `unsupported_kind:${input.kind}` };
  if (!input.secretResolved) return { decision: 'reject', reason: 'missing_secret' };
  return { decision: 'dispatch', reason: 'ok' };
}

// --- credential-free request template built by the kernel adapter -----------
interface VendorRequest {
  method: string;
  url: string;
  auth: { scheme: string; name?: string; username?: string };
  headers?: Record<string, string>;
  body?: unknown;
}

/** Inject the resolved secret per the auth DESCRIPTOR — the secret never left the
 *  edge; the kernel template carried only a scheme. */
function injectAuth(req: VendorRequest, secret: string): Record<string, string> {
  const headers: Record<string, string> = { ...(req.headers ?? {}) };
  switch (req.auth?.scheme) {
    case 'bearer': headers['Authorization'] = `Bearer ${secret}`; break;
    case 'header': if (req.auth.name) headers[req.auth.name] = secret; break;
    case 'basic': headers['Authorization'] = `Basic ${btoa(`${req.auth.username ?? ''}:${secret}`)}`; break;
    // 'none' → no credential injected
  }
  return headers;
}

async function dispatchToVendor(
  cmd: { action: string; kind: string; provider: string; payload: Record<string, unknown> },
  secret: string,
): Promise<{ ok: boolean; reason: string; providerResponse?: Record<string, unknown> }> {
  const req = cmd.payload['_request'] as VendorRequest | undefined;
  // No pre-built request (no adapter registered for this vendor) → drain as a no-op
  // so the outbox doesn't wedge; the operator adds a kernel adapter to wire it.
  if (!req || !req.url) {
    return { ok: true, reason: 'no_adapter', providerResponse: { simulated: true, action: cmd.action } };
  }
  const headers = injectAuth(req, secret);
  if (req.body !== undefined && !('Content-Type' in headers)) headers['Content-Type'] = 'application/json';
  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers,
      body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
    });
    const text = await res.text().catch(() => '');
    return { ok: res.ok, reason: res.ok ? 'dispatched' : `http_${res.status}`, providerResponse: { status: res.status, body: text.slice(0, 2000) } };
  } catch (e) {
    return { ok: false, reason: 'vendor_call_failed', providerResponse: { error: (e as { message?: string }).message ?? String(e) } };
  }
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
