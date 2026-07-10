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
| `JWT_SECRET` | **yes** | HS256 secret the `JwtAuthenticator` verifies. Must match whatever mints your tokens (e.g. Supabase Auth / GoTrue). No secret → the process refuses to start. |
| `SUPABASE_FUNCTIONS_URL` | for durability | e.g. `https://<ref>.supabase.co/functions/v1` (the write arm). |
| `SUPABASE_SERVICE_ROLE_KEY` | for durability | Service-role JWT the persist-world function requires. **Secret.** |
| `DATABASE_URL` | for rehydrate | Postgres connection string used for cold-start reads. **Secret.** |
| `BOOT_TENANTS` | no | Comma-separated tenant ids to rehydrate. If unset and `DATABASE_URL` is set, all tenants are enumerated (`select id from tenant`). |
| `PORT` | no | Listen port (default 8080). |
| `FLUSH_DEBOUNCE_MS` | no | Debounce before flushing a tenant's writes (default 1500). |
| `PERIODIC_FLUSH_MS` | no | Safety-net flush interval for still-dirty tenants (default 30000). |

Without `SUPABASE_*` the App runs **in-memory only** (a valid smoke test, not durable).

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
