-- Bank accounts: operating vs TRUST. Many jurisdictions require security-deposit
-- cash to be held in a segregated trust account, not commingled with operating
-- cash. A trust bank account maps to its own GL cash account, so deposits book
-- there. Deny-by-default forced RLS. Additive: deposit.cash_account records the
-- account a deposit's money sits in, so the refund returns from the same one.
create table bank_account (
  id          text primary key,
  tenant_id   text not null references tenant(id),
  code        text not null,
  name        text not null,
  kind        text not null default 'operating', -- operating | trust
  gl_account  text not null,
  entity_id   text references legal_entity(id)
);
create index on bank_account (tenant_id);

alter table bank_account enable row level security;
alter table bank_account force row level security;

alter table deposit add column if not exists cash_account text;
