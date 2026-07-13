-- Unit types / floorplans — the multifamily merchandising unit. A 200-unit
-- building is a handful of floorplans (1BR, 2BR…) with units hanging off them:
-- details + market rent live ONCE on the type; every unit references it.
-- Additive and backward-compatible: unit.type_id is nullable, untyped units
-- keep working exactly as before.
create table unit_type (
  id               text primary key,
  tenant_id        text not null references tenant(id),
  code             text not null,
  name             text not null,
  bedrooms         integer,
  bathrooms        integer,
  max_guests       integer,
  area_sqm         numeric(8,1),
  base_rent_cents  bigint,
  description      text
);
create index on unit_type (tenant_id);

alter table unit_type enable row level security;
alter table unit_type force row level security;

alter table unit add column if not exists type_id text references unit_type(id);
create index on unit (type_id);
