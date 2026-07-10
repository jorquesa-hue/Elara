# Unified Stay OS

Event-sourced property-management kernel for the full guest lifecycle —
**nightly → monthly → lease** — with a policy-gated agent runtime. Zero runtime
dependencies in the kernel.

## Quickstart

```bash
npm i -D tsx typescript @types/node
npx tsx --test tests/*.test.ts   # 249/249
npx tsx demo.ts                  # end-to-end lifecycle acceptance (in-process)
npx tsx demo-live.ts             # same lifecycle persisted via the adapter
                                 #   DATABASE_URL set → commit; unset → emit SQL
npx tsx demo-portal.ts           # operator portal + API → http://localhost:8787
npx tsx scripts/gen-seed.mjs     # regenerate policy SQL from TS
```

The portal opens on a setup wizard — pick a **language** (English / Português /
Español) and **currency** and watch them flow through the whole app, including
the ledger. Four demo tokens exercise the access-profiling roles (owner,
front desk, AI agent, read-only).

## What's here

- `src/` — the domain kernel (see `docs/unified-stay-os-spec.md` §3 for the map).
- `tests/` — twenty-nine tranches, 249 tests.
- `schema.sql` + `supabase/migrations/` — Postgres persistence; double-inventory
  and journal-balance are enforced at the DB, not just in app code.
- `supabase/functions/persist-world/` — the runtime write arm, a Deno Edge
  Function hosted inside Supabase. It takes a domain-level world, projects it
  FK-ordered server-side, and applies the batch in one transaction with the
  deferred balance constraint validated — so autonomous persistence works
  without exposing raw SQL or a DB connection string. `src/persistence/edge-client.ts`
  is the zero-dep caller (`persistWorldViaEdge`).
- `demo.ts` — the P0 acceptance script.

See `CLAUDE.md` for the standing brief and the seven non-negotiable invariants,
and `CLAUDE-CODE-P0-PROMPT.md` for the staged build plan.
