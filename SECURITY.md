# Security review — Unified Stay OS (Elara)

Scope: the whole Public-API surface — the three gates (auth → RBAC → PolicyEnvelope),
secret handling, tenant isolation, SQL injection, and the persistence write/read arms.
Reviewed 2026-07-10 against the live schema on `shplrbhwpttsukwgaxli`.

## Architecture holds (verified)

- **No policy bypass.** Every money/regulated mutation routes through `App.gated()` →
  `AgentRuntime.execute` → `PolicyEnvelope.decide()` *before* the effect runs
  (agent-runtime.ts). Unknown actions deny-by-default. Escalations park the closure on
  the exception queue and only run on explicit human approval; the `agent` role lacks
  `exception.approve`, so an agent cannot approve its own escalation.
- **Agent tool surface has no side door.** `src/agent/tools.ts` reaches the kernel only
  through `App.dispatch`, so agent tool-calls pass the same three gates as any caller.
- **SQL is fully parameterized.** Both the write projection (`project.ts`, 304 `$n`
  placeholders) and the read layer (`repository.ts`) bind every value; identifiers are
  static literals. No string-concatenated SQL anywhere.
- **Credentials never enter the kernel.** Integrations store only non-secret config plus a
  `secretRef` pointer; e-sign stores only a non-secret `providerRef`. Real vendor I/O lives
  in edge adapters that resolve the secret store.
- **RLS deny-by-default** on all tenant tables; operational tables are service-role only.
  Advisor state: only INFO `rls_enabled_no_policy` (intentional) + one accepted WARN
  (`btree_gist` in public — the live EXCLUDE constraint depends on its opclass).

## Findings fixed this pass

| # | Sev | Finding | Fix |
|---|-----|---------|-----|
| 1 | MED | **Connector-outbox money rail bypassed `bill.pay`.** A `connector.dispatch` to a bank/payment_gateway integration was unconditionally `allow`, so a large payout could leave the business without the human-approval control that guards `bill.pay`. | New rule `pol-connector-dispatch-payout` escalates when the integration kind is `bank`/`payment_gateway` and `payload.amountCents > R$5,000`; the handler threads `integrationKind` + `amountCents` into the policy context. |
| 2 | MED | **Deposit refunds were unbounded.** `deposit.refund` was `allow` for any amount; the large-refund rule was bound to an action (`payment.refund`) that no endpoint dispatched. | New rule `pol-deposit-refund-large` escalates a net refund (held − deductions) > R$5,000; the handler now computes and threads the net `amountCents`. |
| 3 | MED | **Secret denylist was shallow.** Only snake_case top-level keys were scanned, so `accessToken`, `clientSecret`, nested `{auth:{token}}`, and secrets in connector-command payloads slipped into the DB. | `assertNoSecrets` now collapses keys to lowercase-alphanumeric (catches camelCase), matches on substring, recurses into nested objects/arrays, and also guards connector-command payloads. |
| 4 | MED | **`action_log` was not tenant-scoped.** The shared append-only audit table had no `tenant_id`, so a cold-start `loadWorld` pulled every tenant's audit rows into one tenant's world; `snapshotWorld` likewise emitted the global log. | Added `action_log.tenant_id` (migration `20260710172000`), populated it from the policy context in `AgentRuntime`, and scoped both the snapshot (`actionLogFor(tenantId)`) and the read (`where tenant_id = $1`). |
| — | LOW | **No request-body size cap** — unbounded POST = memory-exhaustion DoS. | `http.ts` rejects bodies over 1 MiB with 413 before buffering. |

All fixes are covered by `tests/tranche31-security.test.ts` (7 tests) plus the extended
`tests/tranche20-integrations.test.ts`. The policy seed was regenerated (49 rules) and
applied live; migration `20260710172000` applied live and probed (rolled back); the
`persist-world` Edge Function was redeployed to **v9** with the tenant-scoped `action_log`
insert (deployed body verified).

## Residual items (documented, not yet changed)

These need a design decision or infrastructure not in this pass; none is an open money-out
or cross-tenant *write* hole.

- **`guest` role reads across the tenant — FIXED.** `AuthContext` now carries an optional
  `partyId` (from the `party_id` JWT claim; see `JwtAuthenticator`). A party-scoped token
  may reach only agreements/invoices its party is linked to — `ownedAgreement`, the agreement
  list, and `GET /invoices/:id` all enforce it, returning 404 (never leaking existence) for
  anything else. Operator tokens carry no `partyId` and are unaffected. Covered by
  `tests/tranche33-guest-scope.test.ts` (5 tests).
- **E-sign completion is relayed from a client-supplied email — FIXED.** `POST
  /signature-envelopes/:id/sign` now requires the new `esign.complete` permission, held
  only by owner/service (via `'*'`) and deliberately NOT in OPS — so an operator/agent
  cannot forge a signature. It also verifies the request carries the envelope's stored
  `providerRef` (the provider's external envelope id set at send), so only a genuine
  provider callback can complete it. Covered by `tranche26` (an agent completion → 403; a
  missing/mismatched providerRef → 403; the service webhook with the matching providerRef →
  completes). The portal's sign action is gated on `esign.complete` and passes the
  providerRef, honestly modelling the provider webhook.
- **Jurisdiction is tenant-mutable — FIXED.** `PUT /config` still re-derives `jurisdiction`
  from the chosen country, but CHANGING an already-established jurisdiction now dispatches
  `config.change_jurisdiction`, an escalate rule — so weakening a regulated control (e.g.
  BR→US to escape the deposit cap) parks for human approval and is recorded in the tenant-
  scoped `action_log`. First-time setup (a tenant not yet configured) applies directly, as
  does a config tweak that doesn't move the jurisdiction. Covered by `tranche28`.
- **`lease.execute` is reserved, not wired — FIXED.** `POST /agreements/:id/execute-lease`
  now dispatches `lease.execute` (gated by the new `agreement.execute` permission, which is
  NOT in OPS — agents cannot initiate). Because the rule ESCALATES in every jurisdiction, the
  endpoint always parks for human approval (202); the binding `lease_executed` event is
  appended only when a human approves the exception — it is never auto-executed. Covered by
  `tranche34` (6 tests). Migration `20260710173000` widened the `agreement_event` type check;
  applied + probed live (rolled back).

## Standing rules (unchanged)

- Never write payment-provider code touching real credentials without explicit human approval.
- Eviction, lease execution in BR/EU, and any irreversible+regulated action escalate to a
  human and are never auto-executed.
- Connector and e-sign credentials never reach the kernel — `secretRef`/`providerRef` only.
