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

## State (as of 2026-07-07)
- Kernel v0.4 complete: 15/15 tests. Run: `npx tsx --test tests/*.test.ts`
- Lifecycle acceptance script: `npx tsx demo.ts` — P0 is DONE when this runs unchanged against the live stack. Runs green in-process today.
- Migrations 20260707170000/1/2/3 APPLIED to Supabase project `shplrbhwpttsukwgaxli` ("Elara PMS", org `llqaczctlhlphhdmyeml` / jorquesa@icloud.com). The earlier "wrong org" issue was resolved by reconnecting the Supabase connector to the account that owns the project; shplrbhwpttsukwgaxli is the live DB target (NOT abandoned).
- DB-level invariants verified against the live DB: calendar_hold EXCLUDE rejects overlapping holds (inv 4); deferred balance trigger rejects unbalanced entries (inv 6); append-only trigger rejects UPDATE/DELETE on journal_line (inv 1). Seed loaded: 18 policy rules, 5 collection stages.
- RLS: deny-by-default on all 12 tenant tables (anon sees nothing until a tenant_id JWT claim exists) PLUS migration 3 locks journal_line + operational tables (policy_rule, collection_stage, action_log, exception_item) — RLS forced, no anon policy, service-role only.
- Security advisor: 0 ERROR/WARN of concern. Remaining = 6 INFO rls_enabled_no_policy (intentional deny-by-default) + 1 WARN btree_gist-in-public (left in place; the live EXCLUDE constraint depends on its opclass, moving it risks breaking inv 4).

## Layout
- src/ — domain kernel: agreement (state machine + conversion + Calendar), ledger, policy-envelope,
  agent-runtime, exception-queue, billing, rate-plan, payments, nfe-ingest, collections, multigaap,
  deposits, amenity, metrics, group-block
- tests/ — three tranches + fixtures (NF-e XML)
- schema.sql — Postgres persistence design (mirrored as migration 20260707170000)
- supabase/migrations/ — 3 migrations; supabase/policy_rule.seed.sql generated seed; scripts/gen-seed.mjs regenerates from TS
- docs/unified-stay-os-spec.md — architecture; §13 lists open gates (purpose, wedge, revenue, capital) that block phases

## Commands
- Setup: `npm i -D tsx typescript @types/node`
- Tests: `npx tsx --test tests/*.test.ts` (must be 15/15 before any commit)
- Typecheck: `npx tsc --noEmit`
- Demo: `npx tsx demo.ts`
- Seed regen: `npx tsx scripts/gen-seed.mjs`

## Behavioral guardrails for you (Claude Code)
- Stage 0 of CLAUDE-CODE-P0-PROMPT.md: restate the invariants back before writing code.
- Conversion logic (nightly→monthly→lease) preserves agreement id and ledger continuity — regression here is critical.
- Never write payment-provider code touching real credentials without explicit human approval in-session.
- Eviction, lease execution in BR/EU, and any irreversible+regulated action: propose to human, never execute.
- Commit after each green subtask; long sessions: /clear and rely on this file to reload context.
