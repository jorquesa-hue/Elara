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
  tenant_id    text,  -- the tenant whose action this was; reads MUST filter on it
  at           timestamptz not null,
  actor        text not null,
  action       text not null,
  effect       text not null,
  rule_id      text,
  outcome      text not null check (outcome in ('executed','denied','escalated')),
  reason       text not null,
  exception_id text
);
create index on action_log (tenant_id, seq);

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

-- ---------------------------------------------------------------------------
-- Master-data reshape v2 (migration 20260708170000) — additive foundations for
-- the broader feature set. Party generalises guest; space generalises unit;
-- legal_entity + charge_type route money; bill/bill_line/ap_payment mirror the
-- receivables. unit and guest remain for backward compatibility.
-- ---------------------------------------------------------------------------
create table party (                       -- a person or organization
  id           text primary key,
  tenant_id    text not null references tenant(id),
  kind         text not null check (kind in ('person','organization')),
  display_name text not null,
  legal_name   text,
  tax_id       text,                        -- CPF / CNPJ / foreign
  email        text,
  phone        text,
  attributes   jsonb not null default '{}'::jsonb,  -- KYC, student questionnaire
  created_at   timestamptz not null default now()
);

create table agreement_party (             -- the role join: who plays what on a lease
  agreement_id text not null references agreement(id),
  party_id     text not null references party(id),
  role         text not null check (role in
                 ('resident','financial_responsible','guarantor','cosigner','occupant','prospect','payee')),
  share_pct    int check (share_pct between 0 and 100),
  from_date    date,
  to_date      date,
  primary key (agreement_id, party_id, role)
);

create table space (                       -- property -> building -> unit -> room -> bed, + common/amenity
  id         text primary key,
  tenant_id  text not null references tenant(id),
  parent_id  text references space(id),
  type       text not null check (type in
               ('property','building','floor','unit','room','bed','common','amenity')),
  code       text not null,
  label      text not null,
  leasable   boolean not null default false,
  capacity   int,
  attributes jsonb not null default '{}'::jsonb,
  unique (tenant_id, code)
);

create table legal_entity (                -- operator / condominium / landlord / SPE
  id        text primary key,
  tenant_id text not null references tenant(id),
  role      text not null check (role in ('operator','condominium','landlord','spe')),
  name      text not null,
  tax_id    text
);

create table charge_type (                 -- typed charge: routes to a GL account + receiving entity
  id                  text primary key,
  tenant_id           text not null references tenant(id),
  code                text not null,
  name                text not null,
  receiving_entity_id text not null references legal_entity(id),
  gl_account          text not null,
  recurring           boolean not null default false,
  unique (tenant_id, code)
);

create table bill (                        -- accounts payable: what we owe a payee
  id          text primary key,
  tenant_id   text not null references tenant(id),
  payee_id    text not null references party(id),
  entity_id   text references legal_entity(id),
  issued_at   timestamptz not null,
  due_at      timestamptz not null,
  currency    text not null default 'BRL',
  total_cents bigint not null check (total_cents > 0),
  paid_cents  bigint not null default 0 check (paid_cents >= 0),
  status      text not null default 'open' check (status in ('open','partially_paid','paid','void')),
  memo        text,
  check (paid_cents <= total_cents)
);

create table bill_line (
  id           bigint generated always as identity primary key,
  bill_id      text not null references bill(id),
  description  text not null,
  account      text not null,
  amount_cents bigint not null check (amount_cents > 0)
);

create table ap_payment (                  -- money out, settling a bill
  id           text primary key,
  bill_id      text not null references bill(id),
  amount_cents bigint not null check (amount_cents > 0),
  method       text not null check (method in ('pix','transfer','card','cash')),
  paid_at      timestamptz not null,
  status       text not null default 'settled' check (status in ('settled','reversed'))
);

create table work_order (                   -- maintenance (Phase 2 module 1)
  id                       text primary key,
  tenant_id                text not null references tenant(id),
  space_id                 text references space(id),
  title                    text not null,
  description              text,
  category                 text,
  priority                 text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  status                   text not null default 'open' check (status in ('open','assigned','in_progress','completed','cancelled')),
  requested_by_party_id    text references party(id),
  assigned_vendor_party_id text references party(id),
  bill_id                  text references bill(id),   -- repair cost reuses AP
  opened_at                timestamptz not null,
  assigned_at              timestamptz, started_at timestamptz, closed_at timestamptz,
  resolution               text, cancel_reason text
);

-- Phase 2 tables (migration 20260709170000): reservations (#6), inspections
-- (#18/#19), communications (#4), bank reconciliation (#5). All deny-by-default
-- + forced RLS. (Reservation calendar holds are an in-memory mirror, not stored.)
create table reservation (
  id text primary key, tenant_id text not null references tenant(id),
  space_id text not null references space(id), holder_party_id text not null references party(id),
  start_at timestamptz not null, end_at timestamptz not null, price_cents bigint, currency text,
  status text not null default 'reserved' check (status in ('reserved','cancelled')),
  reserved_at timestamptz not null, cancelled_at timestamptz, note text
);
create table inspection (
  id text primary key, tenant_id text not null references tenant(id),
  agreement_id text not null references agreement(id), space_id text references space(id),
  kind text not null check (kind in ('move_in','move_out')),
  status text not null default 'scheduled' check (status in ('scheduled','completed','cancelled')),
  scheduled_at timestamptz, conducted_at timestamptz, conducted_by_party_id text references party(id),
  items jsonb not null default '[]'::jsonb, damage_cents bigint, created_at timestamptz not null
);
create table message_thread (
  id text primary key, tenant_id text not null references tenant(id), subject text not null,
  kind text not null check (kind in ('resident','finance','internal')),
  status text not null default 'open' check (status in ('open','resolved')),
  agreement_id text references agreement(id), party_id text references party(id),
  created_at timestamptz not null, resolved_at timestamptz
);
create table message (
  id text primary key, thread_id text not null references message_thread(id), at timestamptz not null,
  author_type text not null check (author_type in ('party','user','agent')),
  author_id text not null, body text not null,
  direction text not null check (direction in ('inbound','outbound','internal'))
);
create table bank_transaction (
  id text primary key, tenant_id text not null references tenant(id), bank_account_id text,
  posted_at timestamptz not null, amount_cents bigint not null,  -- signed: + inflow / - outflow
  description text not null, reference text,
  status text not null default 'unmatched' check (status in ('unmatched','matched','ignored')),
  matched_type text check (matched_type in ('payment','ap_payment')), matched_id text, matched_at timestamptz
);

-- Charge routing + calendar generalisation (nullable → backward compatible).
alter table invoice       add column if not exists receiving_entity_id text references legal_entity(id);
alter table invoice_line  add column if not exists charge_type         text;
alter table calendar_hold add column if not exists space_id            text references space(id);
-- agreement_event.type check is widened to add: party_assigned, party_released,
-- rent_adjusted, transferred, moved_in, moved_out.
-- All v2 tables carry deny-by-default + forced RLS (service-role only).
