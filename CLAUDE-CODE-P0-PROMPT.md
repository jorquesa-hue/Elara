# CLAUDE-CODE-P0-PROMPT — staged build of the P0 kernel

Execute these stages **in order**. Do not advance past a stage while its tests
fail. Commit after each green subtask.

## Stage 0 — Restate the invariants
Before writing any code, restate the seven non-negotiable invariants (see
`CLAUDE.md` / spec §2) back in your own words. This is a guardrail against
drift, not a formality.

## Stage 1 — Domain kernel core
Implement `ledger.ts`, `agreement.ts` (state machine + `Calendar`),
`policy-envelope.ts`, `exception-queue.ts`, `agent-runtime.ts`.
Gate: tranche 1 (core) green.

## Stage 2 — Money
Implement `rate-plan.ts`, `billing.ts`, `payments.ts`, `deposits.ts`,
`nfe-ingest.ts`. Every money path leaves the ledger balanced.
Gate: tranche 2 (money) green.

## Stage 3 — Extended domain
Implement `amenity.ts`, `collections.ts`, `multigaap.ts`, `metrics.ts`,
`group-block.ts`.
Gate: tranche 3 (extended) green — 15/15 overall.

## Stage 4 — Persistence
Write `schema.sql`, the three migrations, `scripts/gen-seed.mjs`, and RLS.
Never hand-edit generated SQL. The `EXCLUDE` constraint and balance trigger are
the enforcement of record.
Gate: `npx tsx scripts/gen-seed.mjs` regenerates cleanly.

## Stage 5 — Acceptance
`demo.ts` exercises the whole lifecycle through the agent runtime and asserts
every invariant. **P0 is DONE when `npx tsx demo.ts` runs unchanged against the
live stack.**

## Stage 6 — Apply to Supabase
Apply migrations to the project. Verify the `EXCLUDE` constraint and the
balance trigger actually reject bad writes at the DB, then run advisors.
