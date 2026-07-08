-- Master-data reshape v2 (foundations): Party, Space, legal entity + charge
-- catalog, and accounts payable. Additive and backward-compatible — the unit and
-- guest tables remain in place; the new structures sit alongside them. Every new
-- table gets deny-by-default + forced RLS (service-role only), matching the
-- existing posture (migration 3). See docs/unified-stay-os-spec.md and the kernel
-- modules src/{party,space,entity,payables}.ts.

-- ---------------------------------------------------------------------------
-- Party — a person or organization, related to agreements by role.
-- ---------------------------------------------------------------------------
create table party (
  id           text primary key,
  tenant_id    text not null references tenant(id),
  kind         text not null check (kind in ('person','organization')),
  display_name text not null,
  legal_name   text,
  tax_id       text,
  email        text,
  phone        text,
  attributes   jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create index on party (tenant_id);

create table agreement_party (
  agreement_id text not null references agreement(id),
  party_id     text not null references party(id),
  role         text not null check (role in
                 ('resident','financial_responsible','guarantor','cosigner','occupant','prospect','payee')),
  share_pct    int check (share_pct between 0 and 100),
  from_date    date,
  to_date      date,
  primary key (agreement_id, party_id, role)
);
create index on agreement_party (party_id);

-- ---------------------------------------------------------------------------
-- Space — self-referencing tree: property -> building -> ... -> room -> bed,
-- plus bookable common areas and amenities.
-- ---------------------------------------------------------------------------
create table space (
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
create index on space (tenant_id);
create index on space (parent_id);

-- ---------------------------------------------------------------------------
-- Legal entities & the charge catalog — money knows which entity it belongs to.
-- ---------------------------------------------------------------------------
create table legal_entity (
  id        text primary key,
  tenant_id text not null references tenant(id),
  role      text not null check (role in ('operator','condominium','landlord','spe')),
  name      text not null,
  tax_id    text
);
create index on legal_entity (tenant_id);

create table charge_type (
  id                  text primary key,
  tenant_id           text not null references tenant(id),
  code                text not null,
  name                text not null,
  receiving_entity_id text not null references legal_entity(id),
  gl_account          text not null,
  recurring           boolean not null default false,
  unique (tenant_id, code)
);

-- ---------------------------------------------------------------------------
-- Accounts payable — the mirror of the receivables (invoice/payment).
-- ---------------------------------------------------------------------------
create table bill (
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
create index on bill (tenant_id);
create index on bill (payee_id);

create table bill_line (
  id           bigint generated always as identity primary key,
  bill_id      text not null references bill(id),
  description  text not null,
  account      text not null,
  amount_cents bigint not null check (amount_cents > 0)
);

create table ap_payment (
  id           text primary key,
  bill_id      text not null references bill(id),
  amount_cents bigint not null check (amount_cents > 0),
  method       text not null check (method in ('pix','transfer','card','cash')),
  paid_at      timestamptz not null,
  status       text not null default 'settled' check (status in ('settled','reversed'))
);

-- ---------------------------------------------------------------------------
-- Charge routing + calendar generalisation (nullable → backward compatible).
-- ---------------------------------------------------------------------------
alter table invoice      add column if not exists receiving_entity_id text references legal_entity(id);
alter table invoice_line add column if not exists charge_type         text;
alter table calendar_hold add column if not exists space_id           text references space(id);

-- ---------------------------------------------------------------------------
-- Widen the agreement event vocabulary (append-only stream; new fact types).
-- ---------------------------------------------------------------------------
alter table agreement_event drop constraint agreement_event_type_check;
alter table agreement_event add constraint agreement_event_type_check
  check (type in ('created','activated','converted','amended','completed','terminated',
                  'party_assigned','party_released','rent_adjusted','transferred','moved_in','moved_out'));

-- ---------------------------------------------------------------------------
-- RLS: deny-by-default + forced on every new table (service-role only).
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['party','agreement_party','space','legal_entity','charge_type','bill','bill_line','ap_payment']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
  end loop;
end $$;
