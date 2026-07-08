-- Maintenance / work orders (Phase 2 module 1). A work order is raised on a
-- space, optionally by a requester party and assigned to a vendor party; its
-- repair cost, when external, links to an accounts-payable bill. Mutable-status
-- record (not append-only). Deny-by-default + forced RLS, matching the posture.
create table work_order (
  id                       text primary key,
  tenant_id                text not null references tenant(id),
  space_id                 text references space(id),
  title                    text not null,
  description              text,
  category                 text,
  priority                 text not null default 'normal'
                             check (priority in ('low','normal','high','urgent')),
  status                   text not null default 'open'
                             check (status in ('open','assigned','in_progress','completed','cancelled')),
  requested_by_party_id    text references party(id),
  assigned_vendor_party_id text references party(id),
  bill_id                  text references bill(id),
  opened_at                timestamptz not null,
  assigned_at              timestamptz,
  started_at               timestamptz,
  closed_at                timestamptz,
  resolution               text,
  cancel_reason            text
);
create index on work_order (tenant_id);
create index on work_order (space_id);
create index on work_order (status);

alter table work_order enable row level security;
alter table work_order force row level security;
