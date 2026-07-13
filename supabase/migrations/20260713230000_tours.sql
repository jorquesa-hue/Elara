-- Tour scheduling: the top of the leasing funnel. A prospect requests a tour of
-- a unit at a time; the office confirms, then completes it (advancing the linked
-- lead to 'toured'), marks a no-show, or cancels. Links a lead + unit. Deny-by-
-- default RLS.
create table tour (
  id             text primary key,
  tenant_id      text not null references tenant(id),
  lead_id        text references crm_lead(id),
  unit_id        text references unit(id),
  prospect_name  text not null,
  prospect_email text,
  scheduled_at   timestamptz not null,
  status         text not null default 'requested',
  agent_id       text,
  notes          text,
  created_at     timestamptz not null,
  completed_at   timestamptz,
  cancel_reason  text
);
create index on tour (tenant_id);
create index on tour (lead_id);

alter table tour enable row level security;
alter table tour force row level security;
