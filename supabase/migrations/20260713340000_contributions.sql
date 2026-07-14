-- Owner capital contributions (Phase 7D): the money-IN counterpart to
-- distributions. An owner/investor puts capital INTO a legal entity — it posts
-- the balanced journal entry DR assets:cash / CR equity:contributions
-- (append-only journal_line, already persisted); this table records the
-- contribution itself so it round-trips (like the distribution table beside its
-- journal lines). Deny-by-default RLS.
create table contribution (
  id           text primary key,
  tenant_id    text not null references tenant(id),
  entity_id    text not null references legal_entity(id),
  property_id  text references property(id),
  amount_cents bigint not null check (amount_cents > 0),
  currency     text not null,
  memo         text,
  recorded_at  timestamptz not null
);
create index on contribution (tenant_id);
create index on contribution (entity_id);

alter table contribution enable row level security;
alter table contribution force row level security;
