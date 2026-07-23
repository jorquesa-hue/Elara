-- Property operating budgets: the plan a manager sets a community's revenue and
-- expenses against, so actual NOI (from the ledger, scoped by the journal line's
-- property_id) can be monitored against plan. Config-like (no ledger posting of
-- its own), so a simple durable record with the budget lines as jsonb.
-- Deny-by-default forced RLS.
create table property_budget (
  id           text primary key,
  tenant_id    text not null references tenant(id),
  property_id  text not null references property(id),
  period_start date not null,
  period_end   date not null,
  currency     text not null,
  lines        jsonb not null default '[]'::jsonb,
  notes        text,
  created_at   timestamptz not null,
  check (period_end > period_start)
);
create index on property_budget (tenant_id);
create index on property_budget (property_id);

alter table property_budget enable row level security;
alter table property_budget force row level security;
