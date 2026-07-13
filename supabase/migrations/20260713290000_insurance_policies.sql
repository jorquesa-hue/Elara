-- Renters-insurance policies (Phase 6A): residents on a lease must carry
-- liability coverage. Each policy is keyed to an agreement (the lease) and
-- optionally to the insured resident party; the coverage status (compliant /
-- expiring / lapsed / none) is derived from effective_at/expires_at/status.
-- A liability-tracking record, not a money move — no PolicyEnvelope action.
-- Deny-by-default RLS.
create table insurance_policy (
  id              text primary key,
  tenant_id       text not null references tenant(id),
  agreement_id    text not null references agreement(id),
  party_id        text references party(id),
  carrier         text not null,
  policy_number   text not null,
  liability_cents bigint not null check (liability_cents >= 0),
  effective_at    date not null,
  expires_at      date not null,
  status          text not null default 'active',
  verified_at     timestamptz,
  notes           text,
  created_at      timestamptz not null,
  check (expires_at > effective_at)
);
create index on insurance_policy (tenant_id);
create index on insurance_policy (agreement_id);

alter table insurance_policy enable row level security;
alter table insurance_policy force row level security;
