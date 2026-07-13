-- Preventive-maintenance sweep scheduler (Phase 5C). Mirrors the collections /
-- renewals jobs: once daily against the deployed app with a tenant-scoped service
-- token, so due PM schedules auto-raise work orders. The sweep is idempotent per
-- (schedule, due date), so a daily cadence never double-raises. Absent Vault
-- secrets → the FROM yields zero rows → clean no-op.
--
-- Reuses the Vault secrets from 20260711180000_schedulers (app_url, app_service_token).
select cron.schedule(
  'pm-sweep',
  '30 7 * * *',
  $$
  select net.http_post(
    url := u.decrypted_secret || '/maintenance/pm-sweep',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || t.decrypted_secret),
    body := '{}'::jsonb
  ) from vault.decrypted_secrets u, vault.decrypted_secrets t
  where u.name = 'app_url' and t.name = 'app_service_token'
  $$
);
