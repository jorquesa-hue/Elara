-- Properties / communities — the top-level portfolio rollup a multi-property
-- operator (third-party manager running hundreds of communities) reports and
-- compares on. Units belong to a property; a property optionally belongs to an
-- owning legal entity (SPE/landlord), which scopes owner statements and
-- per-entity books. Additive and backward-compatible: unit.property_id is
-- nullable, so single-property/legacy tenants are unaffected.
create table property (
  id          text primary key,
  tenant_id   text not null references tenant(id),
  code        text not null,
  name        text not null,
  address     text,
  entity_id   text references legal_entity(id)
);
create index on property (tenant_id);
create index on property (entity_id);

alter table property enable row level security;
alter table property force row level security;

alter table unit add column if not exists property_id text references property(id);
create index on unit (property_id);
