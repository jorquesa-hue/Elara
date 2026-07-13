-- Renewals sweep scheduler (Phase 2D). Mirrors the collections-sweep job: once
-- daily against the deployed app with a tenant-scoped service token, so leases
-- approaching expiry get a renewal offer automatically. The sweep is per-tenant
-- and idempotent per (agreement, end), so a daily cadence never double-notifies.
-- If the Vault secrets are absent the FROM clause yields zero rows → clean no-op.
--
-- Reuses the Vault secrets from 20260711180000_schedulers:
--   app_url            the deployed app origin, e.g. https://elara-tvumsw.fly.dev
--   app_service_token  HS256 JWT {tenant_id, user_role:'service'} (runs the sweep)

select cron.schedule(
  'renewals-sweep',
  '0 9 * * *',
  $$
  select net.http_post(
    url := u.decrypted_secret || '/renewals/sweep',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || t.decrypted_secret),
    body := '{}'::jsonb
  ) from vault.decrypted_secrets u, vault.decrypted_secrets t
  where u.name = 'app_url' and t.name = 'app_service_token'
  $$
);
