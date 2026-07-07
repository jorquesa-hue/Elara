-- Migration 20260707170002 — Row-Level Security: deny-by-default on every table.
-- Intentional: anon sees NOTHING until a tenant_id claim exists in the JWT.
-- Tenant isolation is keyed off the 'tenant_id' claim; the service role (used
-- by the trusted backend that fronts the Public API) bypasses RLS as usual.
--
-- Public API is the only API (invariant 3): these policies are what makes the
-- same authenticated surface safe for agents, portal, and website alike.

-- Helper: the caller's tenant, from the JWT. Null when unauthenticated.
create or replace function current_tenant_id() returns text
language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id', '')
$$;

-- Enable RLS + force it (so even table owners are subject to policy) on the
-- 12 tenant-scoped tables. With RLS enabled and no permissive policy, the
-- default is deny.
do $$
declare t text;
begin
  foreach t in array array[
    'tenant','unit','guest','rate_plan','agreement','agreement_event',
    'calendar_hold','invoice','invoice_line','payment','deposit','nfe_document'
  ] loop
    execute format('alter table %I enable row level security;', t);
    execute format('alter table %I force row level security;', t);
  end loop;
end $$;

-- Directly tenant-scoped tables carry a tenant_id column.
create policy tenant_isolation_tenant on tenant
  for select using (id = current_tenant_id());
create policy tenant_isolation_unit on unit
  for select using (tenant_id = current_tenant_id());
create policy tenant_isolation_guest on guest
  for select using (tenant_id = current_tenant_id());
create policy tenant_isolation_rate_plan on rate_plan
  for select using (tenant_id = current_tenant_id());
create policy tenant_isolation_agreement on agreement
  for select using (tenant_id = current_tenant_id());
create policy tenant_isolation_invoice on invoice
  for select using (tenant_id = current_tenant_id());

-- Child tables scope via their parent's tenant.
create policy tenant_isolation_agreement_event on agreement_event
  for select using (exists (
    select 1 from agreement a
    where a.id = agreement_event.agreement_id and a.tenant_id = current_tenant_id()
  ));
create policy tenant_isolation_calendar_hold on calendar_hold
  for select using (exists (
    select 1 from unit u
    where u.id = calendar_hold.unit_id and u.tenant_id = current_tenant_id()
  ));
create policy tenant_isolation_invoice_line on invoice_line
  for select using (exists (
    select 1 from invoice i
    where i.id = invoice_line.invoice_id and i.tenant_id = current_tenant_id()
  ));
create policy tenant_isolation_payment on payment
  for select using (exists (
    select 1 from invoice i
    where i.id = payment.invoice_id and i.tenant_id = current_tenant_id()
  ));
create policy tenant_isolation_deposit on deposit
  for select using (exists (
    select 1 from agreement a
    where a.id = deposit.agreement_id and a.tenant_id = current_tenant_id()
  ));
-- NF-e documents are AP artifacts without a tenant column in this cut; keep
-- them deny-by-default (RLS enabled, no permissive policy) until AP is
-- tenant-scoped. Service-role backend still reads them.

-- Note: policy_rule, collection_stage, action_log, exception_item are
-- operational/config tables served only through the trusted backend
-- (service role) and are intentionally left without anon policies.
