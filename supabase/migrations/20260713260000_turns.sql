-- Unit turns (make-ready): the operations board tracking a vacant unit from
-- move-out through its make-ready checklist to rent-ready. Turn time (vacate →
-- ready) is the multifamily ops KPI. Tasks are a jsonb checklist. Deny-by-default RLS.
create table unit_turn (
  id            text primary key,
  tenant_id     text not null references tenant(id),
  unit_id       text not null references unit(id),
  status        text not null default 'open',
  vacated_at    timestamptz not null,
  ready_at      timestamptz,
  tasks         jsonb not null default '[]'::jsonb,
  agent_id      text,
  notes         text,
  created_at    timestamptz not null,
  cancel_reason text
);
create index on unit_turn (tenant_id);
create index on unit_turn (unit_id);

alter table unit_turn enable row level security;
alter table unit_turn force row level security;
