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

Every module is pure and zero-runtime-dependency (invariant 7). Grouped by concern:

**Core leasing + money**

| Module | Responsibility |
| --- | --- |
| `agreement.ts` | Agreement state machine (event-sourced) + `Calendar` (in-process mirror of the double-inventory constraint); `rent_adjusted`/`transferred`/`moved_in`/`moved_out` events |
| `ledger.ts` | Double-entry ledger; append-only; balance-enforcing |
| `policy-envelope.ts` | `POLICY_RULES` source of truth + `decide()`; per-jurisdiction rule scoping (`jurisdictions?`, `effectiveRulesFor`) |
| `agent-runtime.ts` | The only execution path for agents; gates + logs (tenant-scoped) every call |
| `exception-queue.ts` | Parks escalated actions for human approval |
| `rate-plan.ts` | Pricing + quotes |
| `billing.ts` | Invoices → ledger; chart of accounts (`ACCOUNTS`); charge-routing |
| `payables.ts` | Accounts payable (AP): bills, bill lines, ap_payments (resident refund = bill to payee) |
| `payments.ts` | Provider-agnostic settlement → ledger |
| `deposits.ts` | Security deposits as a liability, refund w/ deductions |
| `amenity.ts` | Chargeable extras catalog |
| `nfe-ingest.ts` | Brazilian NF-e supplier-invoice parse → AP (zero-dep XML read) |
| `collections.ts` | Overdue escalation ladder + late-fee math |
| `multigaap.ts` | Accrual vs cash revenue-recognition projections |
| `metrics.ts` | Occupancy, ADR, RevPAR |
| `group-block.ts` | Corporate/event blocks + pickup without double-booking |

**Master-data reshape v2 (identical structure for every country)**

| Module | Responsibility |
| --- | --- |
| `party.ts` | `PartyDirectory`: person/org parties + agreement roles (resident/guarantor/payee…); `billTo` = payer-or-resident |
| `space.ts` | `SpaceTree`: property→building→unit→room→bed + common/amenity, leasable flag |
| `entity.ts` | `EntityCatalog`: legal entities (operator/condominium/landlord/spe) + charge-type routing (code → gl_account + receiving entity) |

**Feature modules (23-feature roadmap)**

| Module | Feature |
| --- | --- |
| `maintenance.ts` | Work orders on spaces → vendor → AP bill (#3) |
| `reservations.ts` | Common-area/amenity reservations over the shared calendar (#6) |
| `inspection.ts` | Move-in/out vistorias → damage estimate feeds deposit refund (#18/#19) |
| `communications.ts` | Threads/messages; agent-drafted sends pass policy (#4) |
| `reconciliation.ts` | Bank-transaction import + deterministic match ranker (#5) |
| `integrations.ts` | Connector framework: non-secret config + `secretRef` + policy-gated command outbox (#7/#12/#13/#14/#16/#17) |
| `revenue.ts` | Dynamic pricing engine (basis-point factors) + occupancy/ADR/RevPAR KPIs (#1) |
| `procurement.ts` | Purchase orders (encumbrances) + budgets (plan vs commitment vs actual) (#2) |
| `roommate.ts` | Student roommate compatibility scoring + room grouping (#9) |
| `onboarding.ts` | Zero-dep CSV importer + column-mapping "AI migration" seam (#15) |
| `crm.ts` | Leasing pipeline funnel + KPI rollups (#20) |
| `esign.ts` | Lease e-signature envelope state machine (advances the sale; does NOT execute the lease) (#17) |

**Platform layer (per-country environments)**

| Module | Responsibility |
| --- | --- |
| `country.ts` | `COUNTRY_PROFILES` (BR/US/PT/ES/MX/GB): currency/locale/timezone/jurisdiction/taxIdLabel |
| `environment.ts` | `MASTER_DATA_STRUCTURE` single constant + `buildEnvironment(country)` → per-country blueprint over the identical structure |
| `config.ts` | `TenantConfig`: country+jurisdiction (jurisdiction derived from country), locale/currency/timezone/businessStructure; `formatMoney` |
| `i18n.ts` | en / pt-BR / es catalogs |
| `rbac.ts` | Granular permissions + built-in + custom roles (orthogonal to the policy envelope) |
| `master-data.ts` | Units/guests/users/rate-plans (tenant-scoped; `code` = reporting key) |
| `subscription.ts` | Per-unit SaaS metering |

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

Escalated by policy (49 rules, `gen-seed` → seed, applied live): `lease.execute`
(regulated everywhere), `bill.pay` and PO approval over R$5,000, **connector
commands to a bank/payment_gateway integration over R$5,000** (closes the parallel
money-out rail around `bill.pay`), **deposit refunds over R$5,000**, the BR/EU
security-deposit cap over R$9,000 (jurisdiction-scoped), `collections.suspend`, and
`collections.evict`. These move money out, or are irreversible/regulated, and are
never auto-executed.

**Per-jurisdiction divergence from one source.** A `PolicyRule` may carry
`jurisdictions?` — undefined means global, a set means the rule applies only in those
jurisdictions (from the tenant's country). `decide()` skips a rule whose jurisdictions
exclude `ctx.jurisdiction`; `effectiveRulesFor(jurisdiction)` slices the global set. So
the same action + amount can `escalate` for a BR/EU tenant and `allow` for a US tenant
with **no code fork** — the demonstrative `pol-deposit-hold-cap` proves it.

## 6. Persistence (`schema.sql`, `supabase/migrations/`)

11 migrations, all applied live to `shplrbhwpttsukwgaxli`:

- `20260707170000_core_schema.sql` — tables + the three enforcement mechanisms:
  the `calendar_hold` `EXCLUDE` (invariant 4), the deferred journal-balance
  constraint trigger (invariant 6), and append-only triggers (invariant 1).
- `20260707170001_policy_seed.sql` — **generated** from TS by `gen-seed.mjs`.
- `20260707170002_rls.sql` / `…170003_rls_operational_tables.sql` — deny-by-default
  RLS (forced) on every tenant table; anon sees nothing until a `tenant_id` JWT claim
  exists; operational tables (`journal_line`, `policy_rule`, `collection_stage`,
  `action_log`, `exception_item`) are service-role only.
- `…master_data_v2` / `…agreement_guest_nullable` — the party/space/entity/AP reshape.
- `…work_order` / `…phase2_tables` / `…pms_feature_tables` — feature tables (all
  deny-by-default + forced RLS, jsonb where a value is a nested record).
- `…config_and_full_persistence` — tenant config columns + app_user/custom_role/
  integration/connector_command/signature_envelope (nothing lives only in memory).
- `…master_data_fidelity` — `unit.code/active`, `guest.code/email` (closes the last
  lossy projection edge).
- `…action_log_tenant` — `action_log.tenant_id` so the shared audit stream is
  tenant-scoped on read/snapshot (security fix; see SECURITY.md).

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

## 7b. Runtime write arm + cold-start rehydration

The container's egress blocks a direct `pg` connection to Postgres, so the sanctioned
write path is the **`persist-world` Edge Function** (`supabase/functions/persist-world/`),
hosted inside Supabase and reaching Postgres over the internal `SUPABASE_DB_URL`. It
takes a domain-level `WorldData`, projects it FK-ordered **server-side** (callers never
submit raw SQL — invariant 3), asserts journal balance app-side (invariant 6), then
applies the whole batch in one transaction with `set constraints all immediate`
(invariants 4/6). Auth = gateway `verify_jwt` **plus** in-body `role=service_role`.
`projection.ts` is a **verbatim twin** of `src/persistence/project.ts`, held byte-identical
by a drift-guard test — the kernel stays the single source of truth. Currently at v9.

Durability is **bidirectional**. `App.snapshotWorld(tenantId)` folds in-memory state into
a tenant-scoped, FK-parents-first, balanced `WorldData` (the write side, sent incrementally
past a per-tenant high-water mark). `App.rehydrate(world)` is its inverse: every store has a
side-effect-free `hydrate()`, agreements rehydrate from their event stream, and the ledger
loads as stored (no re-post). `Repositories.loadWorld(tenantId)` reads the DB → `WorldData`
to feed rehydrate on boot. Acceptance is a round trip — snapshot A → rehydrate a fresh App B
→ `B.snapshotWorld` deep-equals A's, so nothing the persistence layer captures is lost.

## 8. Testing & acceptance

- `npx tsx --test tests/*.test.ts` — **31 tranches, 269 tests, must be 269/269**
  before any commit. `npx tsc --noEmit` must be clean.
- `npx tsx demo.ts` — end-to-end lifecycle acceptance, in-process.
- `npx tsx demo-live.ts` — the same lifecycle **persisted to the live DB** via
  the adapter (`DATABASE_URL` → commit; otherwise emit a runnable script).
  **P0 is DONE** — verified: the batch applied to the live project, the deferred
  balance trigger validated (trial balance 0), state confirmed, rolled back clean.
- Live DB invariants independently verified: the `calendar_hold` EXCLUDE rejects
  overlapping holds (inv 4), the deferred balance trigger rejects unbalanced entries
  (inv 6), the append-only trigger rejects UPDATE/DELETE on `journal_line` (inv 1).

## 17. Platform layer — configuration, access profiling, master data (P1)

Three cross-cutting concerns make the system deployable by any operator:

**Setup-time configuration (`src/config.ts`, `src/i18n.ts`).** A `TenantConfig`
carries `locale`, `currency` (with correct minor-unit handling — 2 for USD/BRL,
0 for JPY), `timezone`, and `businessStructure` (presets + custom). One `ConfigStore.update`
switches language or currency with immediate effect. Money is stored in integer
**minor units** and is currency-agnostic in the ledger; presentation is a config
concern — `formatMoney` renders via `Intl` for the tenant's locale. The
configured currency **flows into the ledger**: booked agreements, invoices, and
deposits post in the tenant currency. `i18n.ts` holds en / pt-BR / es catalogs
with `t(locale, key, vars)`; the portal fetches a catalog and renders in the
configured language.

**Access profiling (`src/rbac.ts`).** Granular `resource.action` **permissions**;
**roles** bundle them; **users** hold a role. Built-in roles cover the common org
chart (owner, manager, front_desk, accountant, agent, read_only, guest,
service), and tenants **define custom roles** — well-defined yet flexible for any
business structure. This is a second, orthogonal gate to the policy envelope:
RBAC answers "may this user do this at all?", the envelope answers "is this
action safe to auto-execute?". The API enforces a required permission per route.

**Master data (`src/master-data.ts`).** Units, guests, users, and rate plans as
flat, id-stable, tenant-scoped records, each with a `code` (the external/reporting
join key distinct from the internal id, unique per tenant). The shapes map
cleanly onto API payloads and report rows; `GET /reporting/summary` is a single
call for dashboards and exports.

## 18. Operator portal (P1)

`src/api/portal.html` is a self-contained, **zero-dependency** vanilla-JS SPA
(no build step) served by the http layer at `/`; everything else is the Public
API it consumes (invariant 3). It opens on a **setup wizard** (workspace name,
language, currency, timezone, business structure), then a dashboard (reporting
rollup), agreements (book / activate / convert) with an **agreement-detail view**
that operates the full money lifecycle — issue invoice, record payment,
hold/refund deposit (each permission-gated) — plus invoices/payments/deposits
tables and an event-history timeline (backed by `GET /agreements/:id/billing`),
ledger (trial balance), and a Users & Roles admin (list/define custom roles,
add users). Money is formatted per the tenant's locale + currency. Brand mark
plus persisted light/dark themes. The nav and labels are driven by the fetched i18n catalog; every
button reflects the caller's permissions. Run it: `npx tsx demo-portal.ts`
(four demo tokens exercise different roles).

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
- **RBAC** — between auth and policy, the route's required `resource.action`
  permission must be in the caller's role (`src/rbac.ts`); missing → 403. RBAC and
  policy are orthogonal: RBAC answers "may this user do this at all?", policy answers
  "is this action safe to auto-execute?".
- **Endpoints** — agreements (create/activate/convert/read + adjust-rent/transfer/
  move-in/move-out), invoices (charge-routed), payments, deposits (hold/refund),
  parties (+ per-agreement roles), spaces, legal-entities, charge-types, bills (+ pay),
  pricing-rules (+ quote) & revenue/summary, purchase-orders (+ approve/receive/close/
  cancel) & budgets, prospects (+ matches) & roommate/grouping, onboarding (preview/
  commit), leads (+ advance/lose) & crm/summary, signature-envelopes (+ send/sign/void),
  work-orders, reservations, inspections, threads/messages, bank-transactions &
  reconciliation, integrations & connector-commands, countries, environment, config,
  ledger trial-balance, exceptions (list/approve — non-agent role), reporting,
  billing subscription, `POST /persist` (durable flush), health. Every mutation passes
  the three gates; `App.persist()`/`snapshotWorld()`/`rehydrate()` are the async I/O
  arms off the synchronous dispatch router.

## 19. Per-country environments (the architectural keystone)

Every country gets its **own setup + config + jurisdiction-scoped policy**, while the
master-data **structure** is byte-for-byte identical everywhere — so one kernel + one
schema deploys per country (or multi-tenant across countries) with **no data-model
fork**. This is guaranteed structurally, not by convention: `MASTER_DATA_STRUCTURE`
(`src/environment.ts`) is a **single constant** (legal_entity, party, space, charge_type,
unit, guest, agreement) that is not parameterised by country — being one constant is the
guarantee it never diverges.

`buildEnvironment(country, overrides?)` is pure/deterministic → an `EnvironmentBlueprint`
{country, jurisdiction, taxIdLabel, config (currency/locale/timezone/businessStructure),
policy (the effective jurisdiction-scoped rule set), collectionStages, masterDataStructure}.
Provisioning BR vs US is the **same migrations + same kernel**, a different blueprint.
`scripts/provision-country.mjs <CC>` prints a country's full setup — verified BR (47
effective rules, 1 jurisdiction-scoped, CNPJ/CPF/BRL) vs US (46 effective, 0 scoped,
EIN/SSN/USD). `GET /environment` returns the calling tenant's blueprint; `GET /countries`
lists the profiles; `PUT /config` accepts a country and re-derives jurisdiction + seeds
defaults.

## 20. Security posture

The full-surface review and its fixes live in **SECURITY.md**. Summary: the three-gate
architecture holds with no policy-bypass path, agent tools reach the kernel only via
`App.dispatch`, SQL is fully parameterized, credentials never enter the kernel
(`secretRef`/`providerRef` only), and RLS is deny-by-default. Money-out is gated on every
rail (invoices/AP/PO/deposit-refund/connector-payout), and the shared `action_log` audit
stream is tenant-scoped on both write and read. Reserved/residual items (guest-role
horizontal read pending a `partyId` claim, e-sign email trust, tenant-mutable jurisdiction,
`lease.execute` reserved-not-wired) are documented there with recommended fixes.
