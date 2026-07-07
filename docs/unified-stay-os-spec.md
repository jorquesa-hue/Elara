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

## 7a. Persistence adapter (`src/persistence/`)

The kernel holds no I/O. `projectWorld()` folds accumulated kernel state
(agreement events, journal lines, holds, invoices, payments, deposits, action
log) into an **FK-ordered batch of parameterized INSERTs** — the event-sourcing
replay into Postgres. A `SqlExecutor` boundary runs the batch: `RecordingExecutor`
captures it (for script generation and tests); `PgExecutor` runs it over `pg` in
one transaction for the production service-role backend (invariant 3). `pg` is
imported dynamically so the kernel's zero-dep guarantee (invariant 7) is intact
for anyone who doesn't opt in.

## 8. Testing & acceptance

- `npx tsx --test tests/*.test.ts` — four tranches, 19 tests, must be 19/19.
- `npx tsx demo.ts` — end-to-end lifecycle acceptance, in-process.
- `npx tsx demo-live.ts` — the same lifecycle **persisted to the live DB** via
  the adapter (`DATABASE_URL` → commit; otherwise emit a runnable script).
  **P0 is DONE when this runs against the live stack** — verified: the batch
  applied to the live project, the deferred balance trigger validated (trial
  balance 0), state confirmed, transaction rolled back clean.

## 16. Read layer (P1)

`Repositories` (`src/persistence/repository.ts`) is the read side that mirrors
`projectWorld`'s write side. It reconstructs kernel-facing views from persisted
rows through a `QueryExecutor` boundary — `PgQueryExecutor` over `pg` in
production (dynamic import; zero-dep guarantee intact), `FakeQueryExecutor` for
tests.

- `loadAgreement(id)` reads the `agreement` row + its ordered `agreement_event`
  rows and calls `Agreement.rehydrate()` — **event-sourced rehydration**: the
  fold reproduces kind/status/rate/period exactly as persisted (regression-
  critical, since conversion preserves id and ledger continuity). Order-
  independent: the events are sorted by `seq` before folding.
- `loadTrialBalance()` computes the tenant-scoped net-per-account from
  `journal_line` joined to the tenant's agreements.
- Every query is tenant-scoped in its `WHERE`, mirroring deny-by-default RLS —
  a repository built for one tenant cannot read another's rows.

Verified against the live DB: the demo world was persisted in a transaction and
the repository's exact SELECTs returned what rehydration consumes (3 events,
folded kind `monthly`, rate 450000, trial balance 0, 1 active hold), then
rolled back clean. Write path (`projectWorld` → executor) and read path
(`Repositories`) now round-trip through real Postgres.

## 15. Agent tool layer (P1)

`AgentToolCatalog` (`src/agent/tools.ts`) exposes the kernel's operations to an
LLM as tools and routes every invocation through `App.dispatch` — so an agent
tool-call passes `PolicyEnvelope.decide()` before any effect (invariant 2) over
the same authenticated surface everything else uses (invariant 3). There is no
path from the catalog to the kernel except through dispatch.

- `catalog.specs()` returns **Anthropic tool-use compatible** definitions
  (`{ name, description, input_schema, strict }`, closed schemas with
  `additionalProperties: false`) — drop straight into the Anthropic SDK's
  `tools` parameter.
- `catalog.invoke(name, input, bearer)` dispatches the mapped request and
  returns `{ content, isError, status }` — `content` is JSON for a
  `tool_result` block, `isError` mirrors a 4xx/5xx so the model can react.
- Escalations (lease execution, large refunds, eviction) come back as their
  own tool results; the agent can `list_exceptions` but `approve_exception`
  requires a non-agent role — an agent bearer is refused.

The module is provider-agnostic: it builds definitions and dispatches results;
it never calls an LLM API and holds no provider credentials (behavioral
guardrail). Wiring it to Claude via the SDK's tool runner (executor-side):

```ts
import Anthropic from '@anthropic-ai/sdk';
import { App, StaticTokenAuthenticator, AgentToolCatalog } from './src/index.ts';

const app = new App({ authenticator: auth });
const catalog = new AgentToolCatalog(app);
const client = new Anthropic();

const response = await client.messages.create({
  model: 'claude-opus-4-8',
  max_tokens: 16000,
  tools: catalog.specs(),               // Anthropic-compatible defs
  messages: [{ role: 'user', content: 'Book unit u-1 for Ana, Jul 1–10, R$200/night.' }],
});
// For each tool_use block: catalog.invoke(block.name, block.input, agentBearer)
// → return { type:'tool_result', tool_use_id: block.id, content, is_error } and loop.
```

## 13. Gates (resolved 2026-07-07)

These strategic gates block P1+ structural work. Answers below are the standing
decisions the build now assumes; revisit deliberately, not by drift.

- **Purpose gate** — one system for operators running *mixed-tenure* portfolios,
  so a single unit can move nightly → monthly → lease without a system change or
  ledger break.
- **Wedge gate — RESOLVED: unified operator (mixed portfolio).** Serve operators
  who already straddle **short-stay (incl. self-operated), corporate/serviced
  apartments, and multifamily** simultaneously. The conversion spine is their
  native pain, and the platform stays segment-general rather than specializing to
  one vertical. Implication for P1: no segment-specific assumptions in the API;
  the agreement kind (nightly/monthly/lease) is the axis of variation.
- **Revenue gate — RESOLVED: per-unit SaaS.** Flat monthly fee per managed unit.
  Modeled by `src/subscription.ts` (metering: managed unit count × per-unit rate)
  and surfaced at `GET /billing/subscription`. This is the platform's charge to
  the operator — distinct from guest billing, which flows through the ledger.
- **Capital gate — RESOLVED: always pass-through.** Never hold guest funds or
  deposit float on balance sheet. A licensed provider settles directly to the
  operator; the kernel only records already-settled facts (Payments is
  provider-agnostic and takes settled inputs — no provider credentials in the
  kernel). Keeps regulatory scope minimal and matches the current design.

P1 build order (keyed off the above): **Public API surface** (§14) → agent tool
layer → live PgExecutor read/write backend.

## 14. Public API surface (P1)

The Public API is the only API (invariant 3). Its core is a transport-agnostic
`dispatch(request) → response` router (`src/api/app.ts`); `src/api/http.ts` binds
it to `node:http` (no third-party deps). Agents, portal, and website all consume
this one surface.

- **Auth** — a bearer token resolves to an `AuthContext { actor, tenantId, role }`
  (`src/api/context.ts`). Missing/unknown token → 401. Every resource is
  tenant-scoped; cross-tenant reads return 404 (existence is not leaked),
  mirroring the DB's deny-by-default RLS.
- **Policy** — every *mutation* is executed through `AgentRuntime.execute()`, so
  `PolicyEnvelope.decide()` runs before the operation (invariant 2). Mapping:
  `allow` → 200/201, `deny` → 403, `escalate` → 202 `{ exceptionId }`.
- **Endpoints** — agreements (create / activate / convert / read), invoices,
  payments, deposits (hold / refund), ledger trial-balance (tenant-scoped),
  exceptions (list / approve — approval requires a non-agent role), billing
  subscription (per-unit SaaS), health.
