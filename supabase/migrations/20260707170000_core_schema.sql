-- Unified Stay OS — Postgres persistence design.
-- Mirrored as migration 20260707170000_core_schema.sql. This file is the
-- readable single-page reference; the migration is what actually runs.
--
-- Invariants enforced at THIS layer (the enforcement of record):
--   (1) event-sourced writes only — agreement_event/journal_line/action_log are
--       append-only via triggers that raise on UPDATE/DELETE.
--   (4) double inventory fails at the DB — calendar_hold carries an EXCLUDE
--       constraint over (unit_id, daterange) WHERE status = 'active'.
--   (6) journals must balance — a deferred constraint trigger checks each
--       entry_id nets to zero at COMMIT.

create extension if not exists btree_gist;   -- for the EXCLUDE constraint

-- ---------------------------------------------------------------------------
-- Tenancy & reference
-- ---------------------------------------------------------------------------
create table tenant (
  id          text primary key,
  name        text not null,
  created_at  timestamptz not null default now()
);

create table unit (
  id          text primary key,
  tenant_id   text not null references tenant(id),
  label       text not null,
  created_at  timestamptz not null default now()
);

create table guest (
  id          text primary key,
  tenant_id   text not null references tenant(id),
  full_name   text not null,
  created_at  timestamptz not null default now()
);

create table rate_plan (
  id          text primary key,
  tenant_id   text not null references tenant(id),
  name        text not null,
  kind        text not null check (kind in ('nightly','monthly','lease')),
  base_cents  bigint not null check (base_cents > 0),
  currency    text not null default 'BRL',
  deposit_cents bigint check (deposit_cents >= 0)
);

-- ---------------------------------------------------------------------------
-- Agreement aggregate (event-sourced)
-- ---------------------------------------------------------------------------
create table agreement (
  id          text primary key,
  tenant_id   text not null references tenant(id),
  guest_id    text not null references guest(id),
  unit_id     text not null references unit(id),
  created_at  timestamptz not null default now()
);

create table agreement_event (
  seq          bigint generated always as identity primary key,
  agreement_id text not null references agreement(id),
  type         text not null check (type in
                 ('created','activated','converted','amended','completed','terminated')),
  at           timestamptz not null,
  payload      jsonb not null default '{}'::jsonb
);
create index on agreement_event (agreement_id, seq);

-- ---------------------------------------------------------------------------
-- Calendar — double inventory is IMPOSSIBLE at the DB layer (invariant 4)
-- ---------------------------------------------------------------------------
create table calendar_hold (
  id         text primary key,
  unit_id    text not null references unit(id),
  holder_id  text not null,            -- agreement id or group-block id
  start_date date not null,
  end_date   date not null,            -- exclusive
  status     text not null default 'active' check (status in ('active','released')),
  check (start_date < end_date),
  -- No two ACTIVE holds on one unit may overlap. Released holds are ignored.
  exclude using gist (
    unit_id with =,
    daterange(start_date, end_date, '[)') with &&
  ) where (status = 'active')
);

-- ---------------------------------------------------------------------------
-- Ledger — append-only, must balance (invariants 1 & 6)
-- ---------------------------------------------------------------------------
create table journal_line (
  id           bigint generated always as identity primary key,
  entry_id     text not null,
  account      text not null,
  debit_cents  bigint not null default 0 check (debit_cents >= 0),
  credit_cents bigint not null default 0 check (credit_cents >= 0),
  currency     text not null default 'BRL',
  agreement_id text references agreement(id),
  memo         text,
  posted_at    timestamptz not null,
  -- exactly one side per line
  check ((debit_cents > 0) <> (credit_cents > 0))
);
create index on journal_line (entry_id);
create index on journal_line (account);
create index on journal_line (agreement_id);

-- Deferred balance check: each entry_id must net to zero at COMMIT.
create or replace function assert_entry_balances() returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  imbalance bigint;
begin
  select coalesce(sum(debit_cents - credit_cents), 0) into imbalance
    from journal_line where entry_id = coalesce(new.entry_id, old.entry_id);
  if imbalance <> 0 then
    raise exception 'journal entry % does not balance: net % cents',
      coalesce(new.entry_id, old.entry_id), imbalance;
  end if;
  return null;
end $$;

create constraint trigger journal_line_balances
  after insert on journal_line
  deferrable initially deferred
  for each row execute function assert_entry_balances();

-- ---------------------------------------------------------------------------
-- Invoices, payments, deposits, amenities, NF-e
-- ---------------------------------------------------------------------------
create table invoice (
  id           text primary key,
  agreement_id text not null references agreement(id),
  tenant_id    text not null references tenant(id),
  issued_at    timestamptz not null,
  due_at       timestamptz not null,
  currency     text not null default 'BRL',
  total_cents  bigint not null check (total_cents > 0),
  paid_cents   bigint not null default 0 check (paid_cents >= 0),
  status       text not null default 'open'
                 check (status in ('open','partially_paid','paid','void')),
  check (paid_cents <= total_cents)
);

create table invoice_line (
  id          bigint generated always as identity primary key,
  invoice_id  text not null references invoice(id),
  description text not null,
  account     text not null,
  amount_cents bigint not null check (amount_cents > 0)
);

create table payment (
  id          text primary key,
  invoice_id  text not null references invoice(id),
  amount_cents bigint not null check (amount_cents > 0),
  method      text not null check (method in ('pix','card','transfer','cash')),
  received_at timestamptz not null,
  status      text not null default 'settled' check (status in ('settled','refunded'))
);

create table deposit (
  id            text primary key,
  agreement_id  text not null references agreement(id),
  amount_cents  bigint not null check (amount_cents > 0),
  currency      text not null default 'BRL',
  status        text not null default 'held' check (status in ('held','refunded')),
  held_at       timestamptz not null,
  refunded_at   timestamptz,
  refunded_cents bigint,
  deductions    jsonb not null default '[]'::jsonb
);

create table nfe_document (
  chave_acesso text primary key check (chave_acesso ~ '^[0-9]{44}$'),
  emit_cnpj    text not null,
  emit_name    text not null,
  total_cents  bigint not null check (total_cents > 0),
  currency     text not null default 'BRL',
  issued_at    timestamptz not null,
  ingested_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Policy + agent runtime
-- ---------------------------------------------------------------------------
create table policy_rule (
  id            text primary key,
  action        text not null,
  effect        text not null check (effect in ('allow','deny','escalate')),
  description   text not null,
  condition_note text,
  ordinal       int not null
);
create index on policy_rule (action, ordinal);

create table action_log (
  seq          bigint generated always as identity primary key,
  at           timestamptz not null,
  actor        text not null,
  action       text not null,
  effect       text not null,
  rule_id      text,
  outcome      text not null check (outcome in ('executed','denied','escalated')),
  reason       text not null,
  exception_id text
);

create table exception_item (
  id          text primary key,
  action      text not null,
  ctx         jsonb not null default '{}'::jsonb,
  reason      text not null,
  status      text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at  timestamptz not null,
  resolved_at timestamptz,
  resolved_by text,
  note        text
);

-- ---------------------------------------------------------------------------
-- Append-only enforcement for the three event streams (invariant 1)
-- ---------------------------------------------------------------------------
create or replace function forbid_mutation() returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'table % is append-only: % is not permitted', tg_table_name, tg_op;
end $$;

create trigger agreement_event_append_only
  before update or delete on agreement_event
  for each row execute function forbid_mutation();

create trigger journal_line_append_only
  before update or delete on journal_line
  for each row execute function forbid_mutation();

create trigger action_log_append_only
  before update or delete on action_log
  for each row execute function forbid_mutation();
