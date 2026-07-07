-- Migration 20260707170003 — close the RLS gap on non-tenant tables.
-- journal_line and the operational/config tables are exposed to PostgREST but
-- had RLS DISABLED, which means anon could read them. They are only ever served
-- through the trusted service-role backend (invariant 3: the Public API is the
-- only API). Enable + force RLS with NO permissive policy → deny-by-default for
-- anon/authenticated, while the service role still bypasses RLS as designed.

do $$
declare t text;
begin
  foreach t in array array[
    'journal_line','policy_rule','collection_stage','action_log','exception_item'
  ] loop
    execute format('alter table %I enable row level security;', t);
    execute format('alter table %I force row level security;', t);
  end loop;
end $$;
