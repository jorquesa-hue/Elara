-- Per-property expense allocation on AP bills (Phase 4A). A bill (and therefore
-- its expense journal lines) can now name the community it belongs to, so owner
-- statements attribute operating expenses to a property instead of folding them
-- all into "Unassigned". Additive + nullable — an unallocated bill still books
-- fine. ADD COLUMN doesn't trip the append-only UPDATE/DELETE journal trigger.
alter table bill add column property_id text references property(id);
create index on bill (property_id);
