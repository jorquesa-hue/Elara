-- Feature persistence wire-up: durable tables for revenue pricing (#1),
-- procurement — purchase orders & budgets (#2), student roommate prospects (#9),
-- and the CRM leasing pipeline (#20). Additive; each table is deny-by-default +
-- forced RLS (service-role only), matching the posture of every tenant table.
-- These modules were previously in-memory only; nothing about their kernel logic
-- changes — this only gives their state a home so it survives restarts.

create table pricing_rule (
  id                 text primary key,
  tenant_id          text not null references tenant(id),
  name               text not null,
  base_cents         bigint not null,
  min_cents          bigint,
  max_cents          bigint,
  weekend_factor_bps integer,
  occupancy_tiers    jsonb not null default '[]'::jsonb,
  lead_time_tiers    jsonb not null default '[]'::jsonb,
  los_discounts      jsonb not null default '[]'::jsonb,
  seasons            jsonb not null default '[]'::jsonb
);
create index on pricing_rule (tenant_id);

create table purchase_order (
  id            text primary key,
  tenant_id     text not null references tenant(id),
  vendor_id     text not null references party(id),
  entity_id     text references legal_entity(id),
  created_at    timestamptz not null,
  expected_at   timestamptz,
  currency      text not null,
  total_cents   bigint not null,
  status        text not null default 'draft' check (status in ('draft','approved','received','closed','cancelled')),
  billed_cents  bigint not null default 0,
  approved_at   timestamptz,
  received_at   timestamptz,
  closed_at     timestamptz,
  cancelled_at  timestamptz,
  memo          text,
  lines         jsonb not null default '[]'::jsonb
);
create index on purchase_order (tenant_id);
create index on purchase_order (vendor_id);

create table budget (
  id           text primary key,
  tenant_id    text not null references tenant(id),
  account      text not null,
  period_start date not null,
  period_end   date not null,
  amount_cents bigint not null,
  label        text
);
create index on budget (tenant_id);

create table roommate_prospect (
  id          text primary key,
  tenant_id   text not null references tenant(id),
  name        text not null,
  party_id    text references party(id),
  preferences jsonb not null default '{}'::jsonb
);
create index on roommate_prospect (tenant_id);

create table crm_lead (
  id              text primary key,
  tenant_id       text not null references tenant(id),
  name            text not null,
  source          text,
  stage           text not null default 'new' check (stage in ('new','toured','applied','approved','signed','lost')),
  est_value_cents bigint not null default 0,
  party_id        text references party(id),
  created_at      timestamptz not null,
  updated_at      timestamptz not null,
  stage_at        jsonb not null default '{}'::jsonb,
  lost_reason     text
);
create index on crm_lead (tenant_id);
create index on crm_lead (stage);

do $$
declare t text;
begin
  foreach t in array array['pricing_rule','purchase_order','budget','roommate_prospect','crm_lead']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
  end loop;
end $$;
