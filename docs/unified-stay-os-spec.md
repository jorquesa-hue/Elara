# Unified Stay OS — Architecture Spec

Unified Stay OS is an event-sourced property-management system (PMS) for the
full guest lifecycle: a stay begins as a **nightly** booking, may convert to a
**monthly** arrangement, and may convert again into a **lease** — all while
preserving one agreement identity and one continuous ledger. Autonomous agents
operate the system through the same authenticated Public API a human portal
uses, and every agent action is gated by an explicit policy envelope.

## 1. Design goals

- **One source of truth per fact.** Agreement state is a fold over an append-only
  event stream; money is a fold over an append-only ledger. Everything else
  (occupancy, GAAP views, KPIs) is a projection, never a second write path.
- **Safety by construction.** The dangerous invariants (no double inventory,
  journals balance, no destructive writes) are enforced at the database, not
  merely in application code.
- **Agent-operable.** Agents are first-class API clients. They cannot bypass
  policy; irreversible/regulated actions escalate to humans.

## 2. The seven non-negotiable invariants

1. Event-sourced writes only — no destructive `UPDATE`/`DELETE` on
   `agreement_event`, `journal_line`, `action_log`.
2. Every agent tool-call passes `PolicyEnvelope.decide()` **before** execution.
3. The Public API is the only API — agents, portal, and website share it.
4. Double inventory fails at the DB `calendar_hold` `EXCLUDE` constraint, never
   only in app code.
5. Policy rules live in TypeScript arrays (`src/policy-envelope.ts`,
   `src/collections.ts`); SQL is regenerated via `scripts/gen-seed.mjs`.
6. Journals must balance — the DB trigger enforces; services assert additionally.
7. The kernel stays zero-runtime-dependency.

## 3. Domain kernel (`src/`)

| Module | Responsibility |
| --- | --- |
| `agreement.ts` | Agreement state machine (event-sourced) + `Calendar` (in-process mirror of the double-inventory constraint) |
| `ledger.ts` | Double-entry ledger; append-only; balance-enforcing |
| `policy-envelope.ts` | `POLICY_RULES` source of truth + `decide()` |
| `agent-runtime.ts` | The only execution path for agents; gates + logs every call |
| `exception-queue.ts` | Parks escalated actions for human approval |
| `rate-plan.ts` | Pricing + quotes |
| `billing.ts` | Invoices → ledger; chart of accounts (`ACCOUNTS`) |
| `payments.ts` | Provider-agnostic settlement → ledger |
| `deposits.ts` | Security deposits as a liability, refund w/ deductions |
| `amenity.ts` | Chargeable extras catalog |
| `nfe-ingest.ts` | Brazilian NF-e supplier-invoice parse → AP (zero-dep XML read) |
| `collections.ts` | Overdue escalation ladder + late-fee math |
| `multigaap.ts` | Accrual vs cash revenue-recognition projections |
| `metrics.ts` | Occupancy, ADR, RevPAR |
| `group-block.ts` | Corporate/event blocks + pickup without double-booking |

## 4. Conversion lifecycle (critical path)

`nightly → monthly → lease` is forward-only. `Agreement.convert()`:

- keeps the **same agreement id** (ledger continuity keys off it),
- appends a `converted` event (never mutates prior state),
- refuses backward or same-tier conversions.

Regression in conversion is treated as critical: the agreement id and the ledger
history for that id must survive every conversion unchanged.

## 5. Policy envelope & agent runtime

`AgentRuntime.execute(action, ctx, at, fn)` **always** calls
`PolicyEnvelope.decide()` before `fn`:

- `allow` → run `fn`, log `executed`.
- `escalate` → park `fn` on the exception queue, log `escalated`; `fn` runs only
  on human `approve()`.
- `deny` (incl. unknown actions, by default) → never run `fn`, log `denied`.

Escalated by policy: `lease.execute`, large refunds (> R$500),
`collections.suspend`, `collections.evict`. These are irreversible and/or
regulated (BR/EU) and are never auto-executed.

## 6. Persistence (`schema.sql`, `supabase/migrations/`)

- `20260707170000_core_schema.sql` — tables + the three enforcement mechanisms:
  the `calendar_hold` `EXCLUDE` (invariant 4), the deferred journal-balance
  constraint trigger (invariant 6), and append-only triggers (invariant 1).
- `20260707170001_policy_seed.sql` — **generated** from TS by `gen-seed.mjs`.
- `20260707170002_rls.sql` — deny-by-default RLS on all 12 tenant tables; anon
  sees nothing until a `tenant_id` JWT claim exists.

## 7. Multi-GAAP

Accrual recognizes revenue at invoice issue; cash recognizes proportional to
receivables actually collected (measured by credits to accounts_receivable, so
deposit/liability inflows never inflate recognized revenue). Both read the one
ledger; neither writes.

## 8. Testing & acceptance

- `npx tsx --test tests/*.test.ts` — three tranches, 15 tests, must be 15/15.
- `npx tsx demo.ts` — end-to-end lifecycle acceptance. **P0 is DONE when this
  runs unchanged against the live stack.**

## 13. Open gates (block later phases)

These strategic gates are intentionally unresolved and block advancing past P0
into later phases; they are product/leadership decisions, not code:

- **Purpose gate** — the single sentence describing who this is for and why now.
- **Wedge gate** — the first beachhead segment (short-stay operators vs.
  student housing vs. corporate serviced apartments) that the nightly→lease
  conversion story serves first.
- **Revenue gate** — pricing model (per-unit SaaS vs. take-rate on GMV vs.
  per-agreement) and the number that makes the unit economics work.
- **Capital gate** — whether deposit float and payment settlement are ever held
  on balance sheet (regulated) or always passed through to a licensed provider.

No P1+ structural work proceeds until each gate has a written answer here.
