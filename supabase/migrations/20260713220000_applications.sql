-- Rental applications: the leasing step between "toured" and "approved". An
-- application captures the applicant, links a lead + unit, carries a screening
-- result (jsonb — credit/background/income from a screening vendor), and ends
-- in an approve/deny decision (FCRA / Fair-Housing sensitive — policy-gated +
-- audited; a denial carries the adverse-action reason). Deny-by-default RLS.
create table application (
  id                     text primary key,
  tenant_id              text not null references tenant(id),
  lead_id                text references crm_lead(id),
  unit_id                text references unit(id),
  applicant_name         text not null,
  applicant_email        text,
  income_cents           bigint,
  status                 text not null default 'submitted',
  submitted_at           timestamptz not null,
  screening              jsonb,
  decided_at             timestamptz,
  decided_by             text,
  adverse_action_reason  text
);
create index on application (tenant_id);
create index on application (lead_id);

alter table application enable row level security;
alter table application force row level security;
