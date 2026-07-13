-- Period close / posting locks. Once an accounting period (tenant × 'YYYY-MM')
-- is closed, no journal entry may post into it — the numbers a fund/owner was
-- given can't silently change. Closing is routine; re-opening is a policy-gated
-- restatement. Deny-by-default forced RLS, service-role only.
create table period_lock (
  tenant_id     text not null references tenant(id),
  period        text not null,               -- 'YYYY-MM'
  status        text not null default 'closed', -- closed | open
  closed_at     timestamptz,
  closed_by     text,
  reopened_at   timestamptz,
  reopened_by   text,
  primary key (tenant_id, period)
);

alter table period_lock enable row level security;
alter table period_lock force row level security;
