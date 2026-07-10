// notification-worker — the runtime drain arm for the notification outbox. Hosted
// inside Supabase (like persist-world / connector-worker) so it reaches Postgres
// over the internal SUPABASE_DB_URL and resolves the provider credential
// (SendGrid for email, Twilio for SMS) from the deployment's secret store
// (Deno.env / Supabase Vault) WITHOUT any credential ever entering the kernel or
// the DB — the notification row holds only the channel + recipient + a canonical
// kind + non-secret template data.
//
// Contract: POST { tenantId?, limit? }. The worker claims pending notification
// rows (optionally for one tenant), renders the per-kind template, sends it via
// the channel's provider, and records sent/failed back on the row. All idempotent
// on the row id (only 'pending' rows are claimed and each is updated once).
//
// A new template kind never touches the send plumbing here: renderMessage() is the
// only vocabulary-aware seam; the transport (fetch to the provider) is generic.
//
// Auth: gateway verify_jwt PLUS in-body role=service_role — only the service-role
// backend/cron may drain the outbox.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import postgres from 'npm:postgres@3';

const DB_URL = Deno.env.get('SUPABASE_DB_URL') ?? '';

// Provider credentials — resolved from the secret store, NEVER from the kernel/DB.
const SENDGRID_API_KEY = Deno.env.get('SENDGRID_API_KEY') ?? '';
const EMAIL_FROM = Deno.env.get('NOTIFICATION_EMAIL_FROM') ?? '';
const TWILIO_ACCOUNT_SID = Deno.env.get('TWILIO_ACCOUNT_SID') ?? '';
const TWILIO_AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN') ?? '';
const SMS_FROM = Deno.env.get('NOTIFICATION_SMS_FROM') ?? '';

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

// --- per-kind template rendering (the only vocabulary-aware seam) ------------
function money(cents: unknown): string {
  const n = Number(cents);
  return Number.isFinite(n) ? (n / 100).toFixed(2) : String(cents ?? '');
}

/** Render a notification's subject + body from its canonical kind + data. This is
 *  a deliberately plain default; a deployment can override with real templates. */
function renderMessage(kind: string, data: Record<string, unknown>): { subject: string; body: string } {
  switch (kind) {
    case 'collections_reminder':
      return {
        subject: 'Payment reminder',
        body: `This is a reminder that invoice ${data.invoiceId ?? ''} for ${money(data.amountCents)} is past due. Please arrange payment at your earliest convenience.`,
      };
    case 'payment_receipt':
      return {
        subject: 'Payment received',
        body: `We received your payment of ${money(data.amountCents)} toward invoice ${data.invoiceId ?? ''}. Thank you.`,
      };
    case 'esign_request':
      return {
        subject: `Please sign: ${data.documentName ?? 'your document'}`,
        body: `A document (${data.documentName ?? ''}, envelope ${data.envelopeId ?? ''}) is ready for your signature.`,
      };
    case 'work_order_update':
      return {
        subject: 'Maintenance update',
        body: `There is an update on your maintenance request ${data.workOrderId ?? ''}.`,
      };
    case 'general':
    default:
      return {
        subject: String(data.subject ?? 'A message'),
        body: String(data.body ?? ''),
      };
  }
}

// --- transport: send via the channel's provider ----------------------------
async function sendEmail(to: string, subject: string, body: string): Promise<{ ok: boolean; reason: string; providerRef?: string }> {
  if (!SENDGRID_API_KEY || !EMAIL_FROM) return { ok: false, reason: 'email_provider_not_configured' };
  try {
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${SENDGRID_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: EMAIL_FROM },
        subject,
        content: [{ type: 'text/plain', value: body }],
      }),
    });
    if (res.ok) return { ok: true, reason: 'sent', providerRef: res.headers.get('x-message-id') ?? undefined };
    const text = await res.text().catch(() => '');
    return { ok: false, reason: `http_${res.status}:${text.slice(0, 200)}` };
  } catch (e) {
    return { ok: false, reason: 'email_send_failed:' + ((e as { message?: string }).message ?? String(e)) };
  }
}

async function sendSms(to: string, body: string): Promise<{ ok: boolean; reason: string; providerRef?: string }> {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !SMS_FROM) return { ok: false, reason: 'sms_provider_not_configured' };
  try {
    const form = new URLSearchParams({ To: to, From: SMS_FROM, Body: body });
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });
    const payload = await res.json().catch(() => ({} as Record<string, unknown>));
    if (res.ok) return { ok: true, reason: 'sent', providerRef: typeof payload.sid === 'string' ? payload.sid : undefined };
    return { ok: false, reason: `http_${res.status}:${String((payload as { message?: string }).message ?? '').slice(0, 200)}` };
  } catch (e) {
    return { ok: false, reason: 'sms_send_failed:' + ((e as { message?: string }).message ?? String(e)) };
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
      `select id, tenant_id, channel, recipient, kind, data
         from notification
        where status = 'pending' ${opts.tenantId ? 'and tenant_id = $1' : ''}
        order by created_at
        limit ${limit}`,
      opts.tenantId ? [opts.tenantId] : [],
    );

    for (const row of pending) {
      const channel = String(row.channel);
      const to = String(row.recipient);
      const kind = String(row.kind);
      const data = (row.data ?? {}) as Record<string, unknown>;
      const { subject, body } = renderMessage(kind, data);

      const out = channel === 'email'
        ? await sendEmail(to, subject, body)
        : channel === 'sms'
        ? await sendSms(to, `${subject ? subject + ': ' : ''}${body}`)
        : { ok: false, reason: `unknown_channel:${channel}` };

      const status = out.ok ? 'sent' : 'failed';
      await sql.unsafe(
        `update notification
            set status = $2, sent_at = now(), failed_reason = $3, provider_ref = coalesce($4, provider_ref)
          where id = $1 and status = 'pending'`,
        [String(row.id), status, out.ok ? null : out.reason, out.providerRef ?? null],
      );
      outcomes.push({ id: String(row.id), status, reason: out.reason });
    }
  } catch (e) {
    return json(500, { error: 'drain_failed', detail: (e as { message?: string }).message ?? String(e) });
  } finally {
    await sql.end({ timeout: 5 });
  }

  return json(200, { ok: true, drained: outcomes.length, outcomes });
});
