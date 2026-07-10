-- Security fix: the action_log audit stream was not tenant-scoped. It is a
-- shared append-only table (one row per policy-gated tool call across ALL
-- tenants), but carried no tenant_id column — so a tenant-scoped cold-start
-- read (Repositories.loadWorld) pulled EVERY tenant's audit rows into one
-- tenant's rehydrated world. Add the column so reads/snapshots can filter.
--
-- Additive + backward-compatible: the column is nullable (historical rows have
-- no tenant); the projection now always writes it for new rows. RLS on the
-- table stays deny-by-default + forced (service-role only) as before — this
-- adds the application-level tenant predicate the read layer relies on.

alter table action_log add column if not exists tenant_id text;

create index if not exists action_log_tenant_idx on action_log (tenant_id, seq);
