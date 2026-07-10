-- Master-data projection fidelity. The unit and guest tables stored only
-- id/label/full_name, so a unit's reporting `code` + `active` flag and a guest's
-- `code` + `email` were dropped by the projection and defaulted on reload. Add
-- those columns so cold-start rehydration restores them faithfully — closing the
-- one known lossy edge in the round-trip. Additive; existing rows backfill code
-- from id. RLS is inherited (these tables were already forced-RLS).

alter table unit  add column if not exists code   text;
alter table unit  add column if not exists active boolean not null default true;
update unit set code = id where code is null;

alter table guest add column if not exists code  text;
alter table guest add column if not exists email text;
update guest set code = id where code is null;
