-- Tenant branding: logo, accent color and a marketing tagline. These drive the
-- operator portal's accent + the public booking website's look. Additive and
-- nullable — existing tenants are unaffected. logo_data_url holds a small
-- data:image base64 URL (or an https URL); the app caps it at ~256 KB.
alter table tenant add column if not exists brand_color   text;
alter table tenant add column if not exists logo_data_url text;
alter table tenant add column if not exists tagline       text;
