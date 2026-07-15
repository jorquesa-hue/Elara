# GO-LIVE — Step 1: deploy + prove durability

Everything the build sandbox could do is ALREADY DONE: all 14 migrations are
applied to the live project, the three edge functions are deployed
(persist-world v16, connector-worker v5, notification-worker v2), and the four
schedulers are running inside Supabase (pg_cron: `notification-drain` and
`connector-drain` every minute, `collections-sweep` daily 08:00 UTC,
`renewals-sweep` daily 09:00 UTC — each is a safe no-op until you add the Vault
secrets in step 4). What remains needs YOUR accounts. Total: ~35 minutes.

Project: `shplrbhwpttsukwgaxli` — https://shplrbhwpttsukwgaxli.supabase.co

---

## 1. Rotate the database password (2 min)

Dashboard → Project Settings → Database → **Reset database password**.
(The old one was exposed during development — rotate before anything else.)
Note the new password; it goes into `DATABASE_URL` below.

## 2. Gather the three secrets (2 min)

From Dashboard → Project Settings:

| Secret | Where | Used as |
| --- | --- | --- |
| **JWT secret** | API → JWT Settings (legacy JWT secret) | `JWT_SECRET` — the app verifies logins with it |
| **service_role key** | API → Project API keys | `SUPABASE_SERVICE_ROLE_KEY` — the durable write arm |
| **DATABASE_URL** | Database → Connection string (URI) with the NEW password | cold-start reads |

The public values are not secrets and are prefilled everywhere:
`SUPABASE_URL=https://shplrbhwpttsukwgaxli.supabase.co`,
`SUPABASE_ANON_KEY=sb_publishable_EdZRG1D4Nr-ML9KSLlia5Q_yMLav9ye`.

## 3. Deploy the container (10 min, Fly example — any Docker host works)

```bash
fly launch --no-deploy --copy-config       # uses the repo's fly.toml + Dockerfile
fly secrets set \
  JWT_SECRET='<jwt secret>' \
  SUPABASE_URL='https://shplrbhwpttsukwgaxli.supabase.co' \
  SUPABASE_ANON_KEY='sb_publishable_EdZRG1D4Nr-ML9KSLlia5Q_yMLav9ye' \
  SUPABASE_FUNCTIONS_URL='https://shplrbhwpttsukwgaxli.supabase.co/functions/v1' \
  SUPABASE_SERVICE_ROLE_KEY='<service_role key>' \
  DATABASE_URL='<postgres connection string>' \
  LOG_LEVEL=info RATE_LIMIT_RPS=20 RATE_LIMIT_BURST=60
fly deploy
fly scale count 1                          # REQUIRED: single instance (in-memory state) — scale UP, not out
```

The boot log should print `starting {"port":8080,"durable":true,...}`.

## 4. Feed the schedulers (3 min)

Dashboard → Project Settings → **Vault** → add three secrets (exact names):

| Vault secret | Value |
| --- | --- |
| `service_role_key` | the service_role key from step 2 |
| `app_url` | your deployed origin, e.g. `https://<app>.fly.dev` |
| `app_service_token` | a tenant-scoped service JWT — mint it: |

```bash
node -e "const{createHmac}=require('crypto');const b=(o)=>Buffer.from(JSON.stringify(o)).toString('base64url');const h=b({alg:'HS256',typ:'JWT'}),p=b({sub:'collections-cron',tenant_id:'<your tenant id>',user_role:'service',exp:Math.floor(Date.now()/1000)+31536000});console.log(h+'.'+p+'.'+createHmac('sha256',process.env.JWT_SECRET).update(h+'.'+p).digest('base64url'))" JWT_SECRET='<jwt secret>' 
```

(1-year expiry — re-mint yearly, or shorter if you prefer. The two drain jobs
start working the moment `service_role_key` exists; collections when all three do.)

## 5. Prove durability — the acceptance round trip (5 min)

```bash
APP_URL=https://<app>.fly.dev JWT_SECRET='<jwt secret>' node scripts/go-live-acceptance.mjs seed
fly machines restart            # or: fly deploy (any full restart)
APP_URL=https://<app>.fly.dev JWT_SECRET='<jwt secret>' node scripts/go-live-acceptance.mjs verify
```

`verify` passing = boot → write → restart → rehydrate round-trips durably — the
one check that could never run from the build sandbox. (It uses a dedicated
`golive-probe` tenant; your real tenants are untouched.)

## 6. First operator user (3 min)

```bash
curl -X POST 'https://shplrbhwpttsukwgaxli.supabase.co/auth/v1/admin/users' \
  -H 'apikey: <service_role key>' -H 'Authorization: Bearer <service_role key>' \
  -H 'content-type: application/json' \
  -d '{"email":"you@company.com","password":"<strong password>","email_confirm":true,
       "app_metadata":{"tenant_id":"<your tenant id>","user_role":"owner"}}'
```

Open `https://<app>.fly.dev`, sign in with that email/password, and run the
setup wizard (country → currency/locale seeded automatically).

## 7. When you're ready for providers (bucket 2 — each is independent)

- **Email/SMS**: Dashboard → Edge Functions → notification-worker → secrets:
  `SENDGRID_API_KEY` + `NOTIFICATION_EMAIL_FROM` (and/or `TWILIO_ACCOUNT_SID`,
  `TWILIO_AUTH_TOKEN`, `NOTIFICATION_SMS_FROM`).
- **Payments / fiscal / e-sign / locks**: register the integration in the portal,
  drop one adapter, put the key in the vault — see DEPLOY.md per section.
- **Dashboards**: point any Prometheus scraper at `GET /metrics` with a
  manager/service token (`metrics.scrape`).
