-- Country environments + full persistence. Two things:
--  1. The tenant's CONFIG (previously in-memory) becomes durable columns on the
--     tenant table, including the country + jurisdiction that make each tenant a
--     country environment. The master-data STRUCTURE is untouched — country is
--     configuration + jurisdiction only, so one schema serves every country.
--  2. The last in-memory modules get a home: platform users, custom roles, the
--     e-signature envelopes (#17), and the connector framework (integrations +
--     command outbox #7/#12/#13/#14/#16/#17). Now nothing lives only in memory.
-- Additive; every new table is deny-by-default + forced RLS (service-role only).

alter table tenant add column if not exists display_name       text;
alter table tenant add column if not exists locale             text not null default 'en';
alter table tenant add column if not exists currency           text not null default 'USD';
alter table tenant add column if not exists timezone           text not null default 'UTC';
alter table tenant add column if not exists business_structure text not null default 'mixed_portfolio';
alter table tenant add column if not exists country            text not null default 'US';
alter table tenant add column if not exists jurisdiction       text not null default 'US';

create table app_user (
  id           text primary key,
  tenant_id    text not null references tenant(id),
  code         text not null,
  display_name text not null,
  role_id      text not null,
  active       boolean not null default true
);
create index on app_user (tenant_id);

create table custom_role (
  tenant_id   text not null references tenant(id),
  role_id     text not null,
  name        text not null,
  description text,
  permissions jsonb not null default '[]'::jsonb,
  primary key (tenant_id, role_id)
);

create table integration (
  id          text primary key,
  tenant_id   text not null references tenant(id),
  kind        text not null,
  provider    text not null,
  status      text not null default 'active' check (status in ('active','disabled')),
  config      jsonb not null default '{}'::jsonb,
  secret_ref  text,
  created_at  timestamptz not null
);
create index on integration (tenant_id);

create table connector_command (
  id             text primary key,
  tenant_id      text not null references tenant(id),
  integration_id text not null references integration(id),
  action         text not null,
  payload        jsonb not null default '{}'::jsonb,
  status         text not null default 'pending' check (status in ('pending','dispatched','succeeded','failed')),
  created_at     timestamptz not null,
  dispatched_at  timestamptz,
  resolved_at    timestamptz,
  result         jsonb
);
create index on connector_command (tenant_id);
create index on connector_command (integration_id);

create table signature_envelope (
  id            text primary key,
  tenant_id     text not null references tenant(id),
  document_name text not null,
  provider      text not null,
  provider_ref  text,
  lead_id       text references crm_lead(id),
  agreement_id  text references agreement(id),
  signers       jsonb not null default '[]'::jsonb,
  status        text not null default 'draft' check (status in ('draft','sent','signed','declined','voided')),
  created_at    timestamptz not null,
  sent_at       timestamptz,
  completed_at  timestamptz,
  void_reason   text,
  decline_reason text
);
create index on signature_envelope (tenant_id);

do $$
declare t text;
begin
  foreach t in array array['app_user','custom_role','integration','connector_command','signature_envelope']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
  end loop;
end $$;
