-- Prospect waitlist (Phase 6D): when a floorplan is fully leased, prospects join
-- a waitlist for it; as a unit turns available the office offers it to the top of
-- the FIFO queue and converts that prospect into a CRM lead. A leasing-funnel
-- record, not a money move — no PolicyEnvelope action. Deny-by-default RLS.
create table waitlist_entry (
  id              text primary key,
  tenant_id       text not null references tenant(id),
  type_id         text references unit_type(id),
  property_id     text references property(id),
  prospect_name   text not null,
  prospect_email  text,
  prospect_phone  text,
  desired_move_in date,
  status          text not null default 'waiting',
  joined_at       timestamptz not null,
  offered_at      timestamptz,
  converted_at    timestamptz,
  lead_id         text,
  notes           text
);
create index on waitlist_entry (tenant_id);
create index on waitlist_entry (type_id);

alter table waitlist_entry enable row level security;
alter table waitlist_entry force row level security;
