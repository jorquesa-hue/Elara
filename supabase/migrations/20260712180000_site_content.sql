-- Website content for the integrated booking site: one jsonb blob per tenant
-- carrying the operator-authored page (hero/about/contact/social) and per-unit
-- marketing details (headline, description, beds/baths/guests, amenities, photo,
-- publish flag). Marketing data only — never residents, money, or PII. Additive
-- and nullable; the app validates + size-caps everything it writes here.
alter table tenant add column if not exists site_content jsonb;
