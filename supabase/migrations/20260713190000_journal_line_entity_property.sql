-- Per-entity / per-property dimensions on the ledger. Journal lines gain the
-- owning legal entity and the property/community they book to, so the income
-- statement, general ledger and OWNER STATEMENTS can be produced per SPE and
-- per community (institutional fund reporting). Additive and nullable — this
-- is DDL (ADD COLUMN), not an UPDATE/DELETE, so the append-only trigger on
-- journal_line is not tripped; existing lines simply carry NULLs.
alter table journal_line add column if not exists entity_id text references legal_entity(id);
alter table journal_line add column if not exists property_id text references property(id);
create index on journal_line (property_id);
create index on journal_line (entity_id);
