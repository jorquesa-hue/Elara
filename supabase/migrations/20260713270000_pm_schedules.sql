-- Preventive maintenance schedules (Phase 5C): recurring upkeep a sweep turns
-- into work orders on a cadence, so routine maintenance happens on time. Each
-- schedule carries its cadence + next-due date; the sweep advances next_due_at
-- and stamps last_run_at. Deny-by-default RLS.
create table pm_schedule (
  id           text primary key,
  tenant_id    text not null references tenant(id),
  title        text not null,
  space_id     text references space(id),
  cadence_days integer not null check (cadence_days > 0),
  priority     text not null default 'medium',
  next_due_at  date not null,
  last_run_at  timestamptz,
  active       boolean not null default true,
  created_at   timestamptz not null
);
create index on pm_schedule (tenant_id);

alter table pm_schedule enable row level security;
alter table pm_schedule force row level security;
