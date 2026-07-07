# Unified Stay OS

Event-sourced property-management kernel for the full guest lifecycle —
**nightly → monthly → lease** — with a policy-gated agent runtime. Zero runtime
dependencies in the kernel.

## Quickstart

```bash
npm i -D tsx typescript @types/node
npx tsx --test tests/*.test.ts   # 34/34
npx tsx demo.ts                  # end-to-end lifecycle acceptance (in-process)
npx tsx demo-live.ts             # same lifecycle persisted via the adapter
                                 #   DATABASE_URL set → commit; unset → emit SQL
npx tsx scripts/gen-seed.mjs     # regenerate policy SQL from TS
```

## What's here

- `src/` — the domain kernel (see `docs/unified-stay-os-spec.md` §3 for the map).
- `tests/` — three tranches, 15 tests.
- `schema.sql` + `supabase/migrations/` — Postgres persistence; double-inventory
  and journal-balance are enforced at the DB, not just in app code.
- `demo.ts` — the P0 acceptance script.

See `CLAUDE.md` for the standing brief and the seven non-negotiable invariants,
and `CLAUDE-CODE-P0-PROMPT.md` for the staged build plan.
