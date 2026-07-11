# Deploying Unified Stay OS

The App (Public API + operator portal + durability lifecycle) runs as a single
container. The kernel is zero-runtime-dependency; the image adds only `tsx` (to run
the `.ts` entrypoint) and the optional `pg` driver (used only for cold-start reads).

## Architecture at runtime

```
        ┌─────────────────────────────────────────────┐
        │  App container (this repo, Dockerfile)       │
        │  • JwtAuthenticator verifies HS256 tokens    │
        │  • dispatch() → 3 gates → in-memory kernel   │
        │  • StayServer: boot-rehydrate + flush-after- │
        │    write (debounced) + periodic safety flush │
        └───────┬───────────────────────────┬──────────┘
        reads (pg, boot)            writes (service-role)
                │                           │
        ┌───────▼────────┐        ┌─────────▼───────────┐
        │  Postgres      │        │  persist-world       │
        │  (Supabase)    │◄───────│  Edge Function       │
        └────────────────┘  tx    └─────────────────────┘
```

- **Writes** go through the deployed `persist-world` Edge Function (service-role),
  which projects a `WorldData` server-side in one transaction (invariants enforced
  in the DB). The App never writes SQL directly.
- **Reads** (only at cold-start, to rehydrate memory) go straight to Postgres via
  `pg` using `DATABASE_URL`.
- Between flushes the in-memory App is the live copy; `flushDebounceMs` bounds the
  data-loss window if the process dies (a failed flush re-sends, since the flush
  mark only advances on success).

## Environment

| Var | Required | Purpose |
| --- | --- | --- |
| `JWT_SECRET` | **yes** | HS256 secret the `JwtAuthenticator` verifies. Must equal your Supabase project's **JWT secret** (the legacy symmetric key GoTrue signs with). No secret → the process refuses to start. |
| `SUPABASE_URL` | for login | Project URL, e.g. `https://<ref>.supabase.co`. Enables the portal's real login screen (against `${SUPABASE_URL}/auth/v1`). |
| `SUPABASE_ANON_KEY` | for login | The **public** anon/publishable key — the portal sends it as `apikey` to GoTrue. Not a secret. |
| `SUPABASE_FUNCTIONS_URL` | for durability | e.g. `https://<ref>.supabase.co/functions/v1` (the write arm). |
| `SUPABASE_SERVICE_ROLE_KEY` | for durability | Service-role JWT the persist-world function requires. **Secret.** |
| `DATABASE_URL` | for rehydrate | Postgres connection string used for cold-start reads. **Secret.** |
| `BOOT_TENANTS` | no | Comma-separated tenant ids to rehydrate. If unset and `DATABASE_URL` is set, all tenants are enumerated (`select id from tenant`). |
| `PORT` | no | Listen port (default 8080). |
| `FLUSH_DEBOUNCE_MS` | no | Debounce before flushing a tenant's writes (default 1500). |
| `PERIODIC_FLUSH_MS` | no | Safety-net flush interval for still-dirty tenants (default 30000). |
| `LOG_LEVEL` | no | `debug`/`info`/`warn`/`error` (default `info`). Structured JSON logs to stdout. |
| `RATE_LIMIT_RPS` | no | Sustained per-principal (tenant+actor) request rate. Unset → limiting off. |
| `RATE_LIMIT_BURST` | no | Token-bucket capacity / max burst (default = `RATE_LIMIT_RPS`). |

Without `SUPABASE_*` the App runs **in-memory only** (a valid smoke test, not durable).

The `notification-worker` Edge Function (not the App container) reads these from the
Supabase secret store — they never enter the kernel or the DB:

| Secret (Edge Function env) | Purpose |
| --- | --- |
| `SENDGRID_API_KEY` + `NOTIFICATION_EMAIL_FROM` | Email transport (SendGrid). Without both, email notifications are marked `failed` with `email_provider_not_configured`. |
| `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` + `NOTIFICATION_SMS_FROM` | SMS transport (Twilio). Without all three, SMS notifications are marked `failed` with `sms_provider_not_configured`. |

## Run

Local:

```bash
JWT_SECRET=dev-secret npm start        # in-memory, http://localhost:8080
```

Container (any host — Fly/Cloud Run/Render/Railway/ECS):

```bash
docker build -t stayos .
docker run -p 8080:8080 \
  -e JWT_SECRET=… \
  -e SUPABASE_FUNCTIONS_URL=https://<ref>.supabase.co/functions/v1 \
  -e SUPABASE_SERVICE_ROLE_KEY=… \
  -e DATABASE_URL=… \
  stayos
```

`fly.toml` is a worked example. **Run a single instance** — the App holds tenant
state in memory and flushes to durable storage; horizontal scaling would fork that
state. Scale *up* (bigger machine), not *out*, until a shared-cache design lands.

## Login (Supabase Auth / GoTrue)

The portal fetches `GET /auth/config` (public, pre-auth) to learn how to sign in:
- with `SUPABASE_URL` + `SUPABASE_ANON_KEY` set → a real **email/password** screen that
  authenticates against GoTrue's password grant, stores the access + refresh tokens,
  and transparently refreshes on a 401;
- without them → a dev "paste a token" gate.

The App verifies the JWT with `JwtAuthenticator` (HS256 over `JWT_SECRET`) and reads
three claims: `tenant_id`, `user_role`, and (for guests) `party_id`. GoTrue does not
put these in a token by default — you inject them as **custom claims under
`app_metadata`** (which GoTrue always includes in the JWT, and which the verifier
reads). Two ways:

**A. Set `app_metadata` on the user (simplest).** Via the Admin API (service role):

```bash
curl -X PUT "$SUPABASE_URL/auth/v1/admin/users/$USER_ID" \
  -H "apikey: $SERVICE_ROLE_KEY" -H "authorization: Bearer $SERVICE_ROLE_KEY" \
  -H "content-type: application/json" \
  -d '{"app_metadata":{"tenant_id":"t-acme","user_role":"manager"}}'
```

For a guest/resident, add `"party_id":"<party>"` and use `"user_role":"guest"`.

**B. A custom access-token hook** (Postgres function) that derives the claims per
login from your own user↔tenant table — better when you manage the mapping yourself.
See the Supabase "custom access token hook" docs; return the same three keys.

Notes:
- `user_role` must be one of the built-in role ids (`owner`/`manager`/`staff`/
  `front_desk`/`accountant`/`agent`/`read_only`/`guest`) or a custom role you defined
  for that tenant. A token with no `tenant_id` claim is rejected (deny-by-default).
- This verifier does **HS256** (the legacy shared JWT secret). If your project uses
  the newer asymmetric signing keys (RS256/ES256 + JWKS), keep the legacy JWT secret
  enabled, or extend `JwtAuthenticator` with JWKS verification.

## Escalations across restarts

Parked policy escalations (the human-approval queue) are persisted
(`exception_item`) and rehydrated on boot, so a restart never silently drops a
pending decision. One nuance: a rehydrated escalation no longer carries its
deferred operation (a closure cannot be persisted), so approving it returns
`{status:"approved", executed:false}` — the decision is recorded and audited, but
the operator must re-initiate the underlying action (it re-escalates with a live
operation attached, and approving that one executes it, `executed:true`). Nothing
is ever silently marked done.

## Privacy — data-subject rights (LGPD / GDPR)

Two operator endpoints handle data-subject requests, both gated on a DPO
permission (owner/service/manager), never OPS:

- `GET /privacy/parties/:id/export` (`privacy.export`) — a subject-access report
  assembling everything Elara holds about a party (record, agreement roles,
  invoices, AP bills, notifications, CRM/roommate links). A party-scoped token (a
  guest) may export only its own party.
- `POST /privacy/parties/:id/erase` (`privacy.manage`; policy `privacy.erase`) —
  the right to be forgotten. It redacts the party's PII (name/tax id/email/phone/
  attributes → tombstone) and its notification recipients, and **retains the
  append-only financial record** (agreement roles, invoices, bills, journal lines)
  by opaque party id. This is the reconciliation with invariant 1: the immutable
  events reference the party by id, so wiping the identifying fields de-identifies
  the subject while the balanced money history stands and financial-record
  retention law is satisfied. The erasure itself is recorded in the tenant
  `action_log` (who erased whom, when). The redaction propagates to the DB through
  the normal party + notification upserts on the next flush.

## Observability

Every request emits a structured JSON log line to stdout (`{at,level,msg:"request",
method,route,status,tenant,durationMs}`) and a metrics sample; the `route` label is
the pattern (`/agreements/:id/billing`), never the concrete path, so cardinality
stays bounded. The logger redacts obviously-sensitive field names and never carries
a token. Point it at your own sink or an error tracker (Sentry/Datadog) by injecting
`observability` into `new App({...})` — no kernel dependency, just the
`Logger`/`Metrics`/`ErrorReporter` interfaces in `src/observability.ts`.

`GET /metrics` returns Prometheus text (`GET /metrics.json` the structured
snapshot), gated behind the `metrics.scrape` permission (owner/service/manager) —
have your scraper carry a token with it. Exposed series:
- `http_requests_total{method,route,status}` and `http_request_duration_ms` (histogram)
- `http_server_errors_total{route}`, `http_rate_limited_total{tenant}`
- `policy_decisions_total{action,outcome}` — the allow/escalate/deny split per action

**Rate limiting** — set `RATE_LIMIT_RPS` (+ optional `RATE_LIMIT_BURST`) to bound
requests per principal (tenant+actor) with a token bucket; over-limit requests get
`429` + `Retry-After`. It applies after auth (an unauthenticated flood is cheaply
`401`'d and should be fronted by an edge/CDN layer).

## Notifications (email / SMS)

The kernel only **records** a notification (channel + recipient + a canonical kind +
non-secret template data) on an outbox; a domain event enqueues it (a collections
reminder on the overdue sweep, an e-sign request per signer on send, a payment
receipt on a recorded payment). The `notification-worker` Edge Function drains the
outbox: it claims `pending` rows, renders the per-kind template, sends via the
channel's provider (SendGrid for email, Twilio for SMS) resolving the credential
from the secret store, and records `sent`/`failed` back on the row. Same discipline
as the connector framework — **no credential ever enters the kernel or the DB**.

Schedule the drain with the service role (external cron or Supabase `pg_cron` +
`pg_net`) — e.g. every minute:

```
POST ${SUPABASE_FUNCTIONS_URL}/notification-worker
Authorization: Bearer <service-role JWT>
{ "limit": 100 }
```

Optionally pass `{"tenantId":"…"}` to drain one tenant. A retry re-enqueues a new
notification (a `failed` row is terminal); only `pending` rows are claimed, so a
re-run never double-sends.

## Fiscal documents (NF-e / NFS-e emission)

Emitting an electronic fiscal invoice is an **outbound connector command** to the
tenant's `fiscal` integration — the same pluggable pattern as door locks or banks.
`POST /invoices/:id/emit-nfe` (perm `connector.dispatch`) resolves the tenant's
active `fiscal` integration, builds a credential-free `emit_invoice` command (the
`generic_fiscal` adapter attaches the vendor request; recipient tax id comes from
the invoice's bill-to party), and enqueues it. The `connector-worker` edge function
(v3, `fiscal` is a dispatchable non-money kind) resolves the certificate/API key
from the secret store and performs the real call to the provider (Focus NFe /
NFe.io / a municipal NFS-e gateway). The authorization returns asynchronously via
`POST /integrations/:id/events` with `fiscal.invoice_authorized` (carrying the
access key / fiscal reference), recorded on the integration's inbound events thread.

Onboarding a fiscal provider = register the integration (`kind: "fiscal"`,
`baseUrl` in config, the API key as a `secretRef` in the vault) — no kernel change;
a vendor-specific adapter is a copy of `generic_fiscal` with the real endpoints.

## Live acceptance (the one end-to-end that can't run in the build sandbox)

The sandbox that authors this repo has no egress to Postgres/the edge, so this must
be run from the deployment (which does have reachability):

1. Boot with `DATABASE_URL` + `SUPABASE_*` set; confirm the log line
   `booted: rehydrated N tenant(s)`.
2. `GET /health` with a valid token → `{"ok":true}`.
3. `POST /agreements …`; within `FLUSH_DEBOUNCE_MS` the log shows `flushed <tenant>`.
4. Restart the container; confirm `GET /agreements/:id` returns the agreement from
   step 3 (proves boot-rehydrate round-trips durable state).

Everything up to step 1 is covered by the in-process suite (tranche38); steps 1–4
are the live smoke test to run once against the real stack.
