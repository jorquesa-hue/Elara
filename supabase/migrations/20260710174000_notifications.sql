-- Notification transport: a durable outbox for outbound email/SMS. The kernel
-- records a notification (channel + recipient + canonical kind + non-secret data);
-- the notification-worker edge function drains it and sends via a provider,
-- resolving the credential from the secret store — no credential is ever stored
-- here. Additive; deny-by-default + forced RLS (service-role only), matching every
-- tenant table. `recipient` avoids the reserved word `to`.

create table notification (
  id            text primary key,
  tenant_id     text not null references tenant(id),
  channel       text not null check (channel in ('email','sms')),
  recipient     text not null,
  kind          text not null,
  data          jsonb not null default '{}'::jsonb,
  status        text not null default 'pending' check (status in ('pending','sent','failed')),
  created_at    timestamptz not null,
  sent_at       timestamptz,
  failed_reason text,
  provider_ref  text
);
create index on notification (tenant_id, status);

alter table notification enable row level security;
alter table notification force row level security;
