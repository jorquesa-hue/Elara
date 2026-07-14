-- Utility billing / RUBS (Phase 6B): a master utility bill for a property that
-- the operator recovers from residents by an allocation ratio (equal /
-- occupancy / area / bedrooms). The allocation itself is computed on demand;
-- this table stores the master bill + which method + whether it has been billed
-- out. The resident charges land as ordinary invoices (the append-only ledger),
-- so nothing money-moving is stored here. Deny-by-default RLS.
create table utility_bill (
  id           text primary key,
  tenant_id    text not null references tenant(id),
  property_id  text not null references property(id),
  utility      text not null,
  period_start date not null,
  period_end   date not null,
  total_cents  bigint not null check (total_cents > 0),
  method       text not null,
  status       text not null default 'draft',
  billed_at    timestamptz,
  notes        text,
  created_at   timestamptz not null,
  check (period_end > period_start)
);
create index on utility_bill (tenant_id);
create index on utility_bill (property_id);

alter table utility_bill enable row level security;
alter table utility_bill force row level security;
