# Unified Stay OS — Claude Code Standing Brief

Read docs/unified-stay-os-spec.md before structural changes. Execute CLAUDE-CODE-P0-PROMPT.md stages IN ORDER; do not advance past a stage with failing tests.

## Non-negotiable invariants
1. Event-sourced writes only. No destructive UPDATE/DELETE on agreement_event, journal_line, action_log.
2. Every agent tool-call passes PolicyEnvelope.decide() BEFORE execution. No bypass paths, ever.
3. Public API is the only API — agents, portal, website consume the same authenticated surface.
4. Double inventory must fail at the DB constraint (calendar_hold EXCLUDE), never only in app code.
5. Policy rules: TypeScript arrays (src/policy-envelope.ts, src/collections.ts) are the single source of truth. Regenerate SQL via scripts/gen-seed.mjs. Never hand-edit supabase/migrations/20260707170001_policy_seed.sql or supabase/policy_rule.seed.sql.
6. Journals must balance; the DB trigger is the enforcement, services assert additionally.
7. Kernel stays zero-runtime-dependency. New deps require written justification in the PR.

## State (as of 2026-07-08)
- Kernel v0.4 complete: 56/56 tests (12 tranches). Run: `npx tsx --test tests/*.test.ts`
- Runtime write path (autonomous persistence): `persist-world` Edge Function DEPLOYED and ACTIVE on shplrbhwpttsukwgaxli (verify_jwt=true, version 1). It runs INSIDE Supabase, reaching Postgres over the internal SUPABASE_DB_URL — this is the sanctioned way around the container's egress block (org policy denies TCP 5432 and HTTPS to supabase.co:443, so runtime `pg` from here is impossible; that limitation is environmental, not code). The function takes a domain-level WorldData, projects it FK-ordered server-side (no raw SQL from callers — inv 3), asserts journal balance app-side (inv 6), then applies the batch in ONE tx + `set constraints all immediate` (inv 4/6). Auth: gateway verify_jwt PLUS in-body role=service_role. Caller side is src/persistence/edge-client.ts (zero-dep fetch; persistWorldViaEdge → EdgePersistResult / throws EdgePersistError on non-200). Source: supabase/functions/persist-world/{index.ts,projection.ts,deno.json}. projection.ts is a verbatim twin of src/persistence/project.ts, drift-guarded byte-for-byte by tranche11. VERIFIED against the live schema: the kernel-projected probe batch (fresh 'edge-probe' tenant) applied cleanly, the deferred balance trigger validated (6 balanced lines), then ROLLED BACK (0 rows left, elara-hq intact). Cannot be invoked over HTTPS from THIS container (egress 403 + no service key here by design); it is the write arm for deployed infra.
- Public API wiring: the App accepts an injected `PersistenceBackend` (src/persistence/edge-client.ts: interface + `edgePersistenceBackend()` factory over persistWorldViaEdge). `App.snapshotWorld(tenantId)` folds in-memory state into a tenant-scoped, FK-parents-first, balanced WorldData (proven projection-ready + balanced by tranche12). `POST /persist` flushes it through the backend — same auth+RBAC gates as dispatch, new `persistence.run` permission (owner/service/manager). It is async I/O so it lives as `App.persist()` OFF the synchronous dispatch() router; http.ts routes POST /persist to it and awaits. No backend → 501; read_only → 403; backend EdgePersistError status is surfaced verbatim. HTTP round-trip smoke-tested in-process (401/200/backend-received-world).
- Lifecycle acceptance: `npx tsx demo.ts` runs the full lifecycle in-process (green). `npx tsx demo-live.ts` projects the accumulated kernel state to SQL and persists it via the persistence adapter — P0 acceptance against the live stack is DONE: the projected batch was applied to shplrbhwpttsukwgaxli in a transaction, the deferred balance trigger validated via SET CONSTRAINTS ALL IMMEDIATE (trial balance 0), state verified (1 agreement, 3 events, 1 active hold, 6 journal lines, invoice paid, 6 action-log rows), then ROLLED BACK to leave the DB clean.
- Persistence adapter: src/persistence/ — zero-dep world projection (projectWorld) builds FK-ordered parameterized INSERTs; SqlExecutor boundary (RecordingExecutor for scripts/tests, optional PgExecutor over `pg` for the production service-role backend). demo-live uses PgExecutor when DATABASE_URL is set, else emits a runnable script.
- Migrations 20260707170000/1/2/3 APPLIED to Supabase project `shplrbhwpttsukwgaxli` ("Elara PMS", org `llqaczctlhlphhdmyeml` / jorquesa@icloud.com). The earlier "wrong org" issue was resolved by reconnecting the Supabase connector to the account that owns the project; shplrbhwpttsukwgaxli is the live DB target (NOT abandoned).
- DB-level invariants verified against the live DB: calendar_hold EXCLUDE rejects overlapping holds (inv 4); deferred balance trigger rejects unbalanced entries (inv 6); append-only trigger rejects UPDATE/DELETE on journal_line (inv 1). Seed loaded: 18 policy rules, 5 collection stages.
- RLS: deny-by-default on all 12 tenant tables (anon sees nothing until a tenant_id JWT claim exists) PLUS migration 3 locks journal_line + operational tables (policy_rule, collection_stage, action_log, exception_item) — RLS forced, no anon policy, service-role only.
- Security advisor: 0 ERROR/WARN of concern. Remaining = 6 INFO rls_enabled_no_policy (intentional deny-by-default) + 1 WARN btree_gist-in-public (left in place; the live EXCLUDE constraint depends on its opclass, moving it risks breaking inv 4).

## Layout
- src/ — domain kernel: agreement (state machine + conversion + Calendar), ledger, policy-envelope,
  agent-runtime, exception-queue, billing, rate-plan, payments, nfe-ingest, collections, multigaap,
  deposits, amenity, metrics, group-block; src/persistence/ — executor + world projection (write) + repository (read: Agreement.rehydrate, tenant-scoped trial balance; PgQueryExecutor) + edge-client (persistWorldViaEdge → the deployed persist-world function)
- tests/ — twelve tranches (core, money, extended, persistence, api, agent, repository, platform, portal, billing-view, edge, persist-api) + fixtures (NF-e XML)
- schema.sql — Postgres persistence design (mirrored as migration 20260707170000)
- supabase/migrations/ — 4 migrations (core schema, policy seed, RLS, RLS operational tables); supabase/policy_rule.seed.sql generated seed; scripts/gen-seed.mjs regenerates from TS
- supabase/functions/persist-world/ — Deno Edge Function: runtime write arm hosted inside Supabase (index.ts handler, projection.ts = verbatim twin of src/persistence/project.ts, deno.json). Deploy via the Supabase MCP `deploy_edge_function`; keep verify_jwt=true.
- docs/unified-stay-os-spec.md — architecture; §13 gates RESOLVED; §14 Public API, §15 agent tools, §16 read layer, §17 platform (config/i18n/rbac/master-data), §18 operator portal (all P1).
- src/api/ — Public API: context (auth), app (dispatch router + 3 gates: auth → RBAC permission → policy; plus async App.persist()/snapshotWorld() for durable flush), http (node:http bind, serves portal at /, routes POST /persist → App.persist). src/agent/tools.ts — AgentToolCatalog (Anthropic-tool-use specs → App.dispatch).
- Platform layer: src/config.ts (TenantConfig: locale/currency w/ minor units/timezone/businessStructure; formatMoney; setup-time switchable, flows into ledger), src/i18n.ts (en/pt-BR/es), src/rbac.ts (granular permissions + built-in + custom roles; orthogonal to policy envelope), src/master-data.ts (units/guests/users/rate-plans, tenant-scoped, code = reporting key), src/subscription.ts (per-unit SaaS).
- Portal: src/api/portal.html — zero-dep vanilla SPA, brand mark + light/dark themes (setup wizard, dashboard, agreements + agreement-detail with billing lifecycle: issue invoice / record payment / hold+refund deposit + event-history timeline, ledger, users&roles); `npx tsx demo-portal.ts` (4 demo tokens by role). Browser QA: `npm run portal:drive` (playwright-core). GET /agreements/:id/billing backs the detail view.

## Commands
- Setup: `npm i -D tsx typescript @types/node`
- Tests: `npx tsx --test tests/*.test.ts` (must be 47/47 before any commit)
- Typecheck: `npx tsc --noEmit`
- Demo (in-process): `npx tsx demo.ts`
- Demo (live persist): `DATABASE_URL=… npx tsx demo-live.ts` (no URL → emits SQL script)
- Seed regen: `npx tsx scripts/gen-seed.mjs`

## Behavioral guardrails for you (Claude Code)
- Stage 0 of CLAUDE-CODE-P0-PROMPT.md: restate the invariants back before writing code.
- Conversion logic (nightly→monthly→lease) preserves agreement id and ledger continuity — regression here is critical.
- Never write payment-provider code touching real credentials without explicit human approval in-session.
- Eviction, lease execution in BR/EU, and any irreversible+regulated action: propose to human, never execute.
- Commit after each green subtask; long sessions: /clear and rely on this file to reload context.
