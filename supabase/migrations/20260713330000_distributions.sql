-- Owner distributions (Phase 7A): the operator returns net operating income to a
-- property's owning legal entity by paying out cash (an equity draw). The money
-- movement is the balanced journal entry DR equity:distributions / CR assets:cash
-- (append-only journal_line, already persisted); this table records the
-- distribution itself so it round-trips (like the deposit table beside its
-- journal lines). Deny-by-default RLS.
create table distribution (
  id           text primary key,
  tenant_id    text not null references tenant(id),
  entity_id    text not null references legal_entity(id),
  property_id  text references property(id),
  amount_cents bigint not null check (amount_cents > 0),
  currency     text not null,
  period_start date,
  period_end   date,
  memo         text,
  recorded_at  timestamptz not null
);
create index on distribution (tenant_id);
create index on distribution (entity_id);

alter table distribution enable row level security;
alter table distribution force row level security;
