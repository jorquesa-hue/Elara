-- Go-live schedulers. The kernel provides idempotent drain/sweep operations;
-- this wires the timers inside Supabase (pg_cron + pg_net) so no external cron
-- service is needed. Every job reads its credential from Supabase Vault at run
-- time — if the Vault secret is absent the FROM clause yields zero rows and the
-- job is a clean no-op (nothing logs a failure, nothing carries a hardcoded key).
--
-- Vault secrets the operator adds (Dashboard -> Project Settings -> Vault):
--   service_role_key   service-role JWT (drains the two edge-function outboxes)
--   app_url            the deployed app origin, e.g. https://stayos.fly.dev
--   app_service_token  HS256 JWT minted with the project JWT secret carrying
--                      {tenant_id, user_role:'service'} (runs the tenant sweep)

create extension if not exists pg_cron;
grant usage on schema cron to postgres;
create extension if not exists pg_net;

-- Outbound email/SMS: drain the notification outbox every minute.
select cron.schedule(
  'notification-drain',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://shplrbhwpttsukwgaxli.supabase.co/functions/v1/notification-worker',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || s.decrypted_secret),
    body := '{"limit":100}'::jsonb
  ) from vault.decrypted_secrets s where s.name = 'service_role_key'
  $$
);

-- Vendor commands (locks, website pushes, NF-e emission): drain every minute.
select cron.schedule(
  'connector-drain',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://shplrbhwpttsukwgaxli.supabase.co/functions/v1/connector-worker',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || s.decrypted_secret),
    body := '{"limit":100}'::jsonb
  ) from vault.decrypted_secrets s where s.name = 'service_role_key'
  $$
);

-- Overdue-collections ladder: once daily at 08:00 UTC against the deployed app
-- (a tenant-scoped service token — the sweep is per tenant and idempotent).
select cron.schedule(
  'collections-sweep',
  '0 8 * * *',
  $$
  select net.http_post(
    url := u.decrypted_secret || '/collections/sweep',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || t.decrypted_secret),
    body := '{}'::jsonb
  ) from vault.decrypted_secrets u, vault.decrypted_secrets t
  where u.name = 'app_url' and t.name = 'app_service_token'
  $$
);
