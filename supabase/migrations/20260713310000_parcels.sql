-- Package / parcel room (Phase 6C): the front desk logs a resident's delivery,
-- notifies them it arrived, and records pickup. A parcel is keyed to the
-- recipient party (and optionally their lease for the unit label). A front-desk
-- operational record, not a money move — no PolicyEnvelope action. Deny-by-
-- default RLS.
create table parcel (
  id              text primary key,
  tenant_id       text not null references tenant(id),
  party_id        text not null references party(id),
  agreement_id    text references agreement(id),
  carrier         text not null,
  tracking_number text,
  description     text,
  location        text,
  status          text not null default 'awaiting',
  received_at     timestamptz not null,
  notified_at     timestamptz,
  picked_up_at    timestamptz,
  picked_up_by    text,
  notes           text
);
create index on parcel (tenant_id);
create index on parcel (party_id);

alter table parcel enable row level security;
alter table parcel force row level security;
