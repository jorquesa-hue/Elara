-- Tenant tag for agreement-less journal lines. Accounts-payable entries (bill
-- issue, AP payments) post with NO agreement_id, so tenant scoping via the
-- agreement join silently dropped them from every tenant-scoped read (trial
-- balance, cold-start loadWorld) AND from the persistence snapshot — AP money
-- history was lost on restart. journal_line.tenant_id carries the owner for
-- those lines; agreement-tied lines may leave it null (scoped via agreement).
-- Additive; the append-only trigger only forbids UPDATE/DELETE of rows, not DDL.

alter table journal_line add column tenant_id text references tenant(id);
create index on journal_line (tenant_id);
