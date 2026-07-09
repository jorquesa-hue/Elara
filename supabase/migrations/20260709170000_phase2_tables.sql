-- Phase 2 persistence wire-up: durable tables for reservations (#6),
-- inspections (#18/#19), communications (#4), and bank reconciliation (#5).
-- Additive; each table is deny-by-default + forced RLS (service-role only),
-- matching the posture. Reservations persist as their own record — the calendar
-- hold that enforces no-overlap is an in-memory mirror rebuilt on load, so it is
-- not stored here (avoids the calendar_hold.unit_id → unit FK, since a
-- reservation is on a space).

create table reservation (
  id              text primary key,
  tenant_id       text not null references tenant(id),
  space_id        text not null references space(id),
  holder_party_id text not null references party(id),
  start_at        timestamptz not null,
  end_at          timestamptz not null,
  price_cents     bigint,
  currency        text,
  status          text not null default 'reserved' check (status in ('reserved','cancelled')),
  reserved_at     timestamptz not null,
  cancelled_at    timestamptz,
  note            text
);
create index on reservation (tenant_id);
create index on reservation (space_id);

create table inspection (
  id                    text primary key,
  tenant_id             text not null references tenant(id),
  agreement_id          text not null references agreement(id),
  space_id              text references space(id),
  kind                  text not null check (kind in ('move_in','move_out')),
  status                text not null default 'scheduled' check (status in ('scheduled','completed','cancelled')),
  scheduled_at          timestamptz,
  conducted_at          timestamptz,
  conducted_by_party_id text references party(id),
  items                 jsonb not null default '[]'::jsonb,
  damage_cents          bigint,
  created_at            timestamptz not null
);
create index on inspection (tenant_id);
create index on inspection (agreement_id);

create table message_thread (
  id           text primary key,
  tenant_id    text not null references tenant(id),
  subject      text not null,
  kind         text not null check (kind in ('resident','finance','internal')),
  status       text not null default 'open' check (status in ('open','resolved')),
  agreement_id text references agreement(id),
  party_id     text references party(id),
  created_at   timestamptz not null,
  resolved_at  timestamptz
);
create index on message_thread (tenant_id);

create table message (
  id          text primary key,
  thread_id   text not null references message_thread(id),
  at          timestamptz not null,
  author_type text not null check (author_type in ('party','user','agent')),
  author_id   text not null,
  body        text not null,
  direction   text not null check (direction in ('inbound','outbound','internal'))
);
create index on message (thread_id);

create table bank_transaction (
  id              text primary key,
  tenant_id       text not null references tenant(id),
  bank_account_id text,
  posted_at       timestamptz not null,
  amount_cents    bigint not null,
  description     text not null,
  reference       text,
  status          text not null default 'unmatched' check (status in ('unmatched','matched','ignored')),
  matched_type    text check (matched_type in ('payment','ap_payment')),
  matched_id      text,
  matched_at      timestamptz
);
create index on bank_transaction (tenant_id);
create index on bank_transaction (status);

do $$
declare t text;
begin
  foreach t in array array['reservation','inspection','message_thread','message','bank_transaction']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
  end loop;
end $$;
