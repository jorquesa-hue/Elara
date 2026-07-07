-- GENERATED FILE — do not edit by hand.
-- Source of truth: src/policy-envelope.ts (POLICY_RULES) and
-- src/collections.ts (COLLECTION_STAGES). Regenerate with:
--   npx tsx scripts/gen-seed.mjs
-- policy_rule + collection_stage seed

delete from policy_rule;
insert into policy_rule (id, action, effect, description, condition_note, ordinal) values
  ('pol-agreement-create', 'agreement.create', 'allow', 'Agents may draft agreements.', null, 0),
  ('pol-agreement-activate', 'agreement.activate', 'allow', 'Agents may activate drafted agreements.', null, 1),
  ('pol-agreement-convert', 'agreement.convert', 'allow', 'Forward conversion nightly→monthly→lease is a routine, reversible-by-amendment operation.', null, 2),
  ('pol-lease-execute', 'lease.execute', 'escalate', 'Executing a lease in BR/EU is regulated and irreversible: propose to human, never execute.', null, 3),
  ('pol-invoice-issue', 'invoice.issue', 'allow', 'Agents may issue invoices from rate plans.', null, 4),
  ('pol-payment-record', 'payment.record', 'allow', 'Agents may record settled payments (no provider credentials in kernel).', null, 5),
  ('pol-payment-refund-large', 'payment.refund', 'escalate', 'Refunds above R$500 require human approval.', 'amount_cents > 50000', 6),
  ('pol-payment-refund', 'payment.refund', 'allow', 'Small refunds are routine.', null, 7),
  ('pol-deposit-hold', 'deposit.hold', 'allow', 'Agents may take security deposits per rate plan.', null, 8),
  ('pol-deposit-refund', 'deposit.refund', 'allow', 'Deposit refunds with itemized deductions are routine.', null, 9),
  ('pol-amenity-charge', 'amenity.charge', 'allow', 'Agents may post catalog amenity charges.', null, 10),
  ('pol-nfe-ingest', 'nfe.ingest', 'allow', 'Agents may ingest supplier NF-e documents into AP.', null, 11),
  ('pol-collections-remind', 'collections.remind', 'allow', 'Payment reminders are routine.', null, 12),
  ('pol-collections-latefee', 'collections.late_fee', 'allow', 'Contractual late fees are routine.', null, 13),
  ('pol-collections-suspend', 'collections.suspend', 'escalate', 'Service suspension is guest-impacting: human confirms.', null, 14),
  ('pol-collections-evict', 'collections.evict', 'escalate', 'Eviction is irreversible and regulated: propose to human, never execute.', null, 15),
  ('pol-groupblock-create', 'group_block.create', 'allow', 'Agents may place group blocks.', null, 16),
  ('pol-groupblock-pickup', 'group_block.pickup', 'allow', 'Agents may convert block holds into agreements.', null, 17);

delete from collection_stage;
insert into collection_stage (id, min_days_overdue, action, policy_action, description, fee_bps, ordinal) values
  ('col-remind-1', 1, 'remind', 'collections.remind', 'Friendly reminder, 1 day overdue.', null, 0),
  ('col-remind-2', 7, 'remind', 'collections.remind', 'Second reminder, 1 week overdue.', null, 1),
  ('col-latefee', 10, 'late_fee', 'collections.late_fee', 'Assess 2% contractual late fee.', 200, 2),
  ('col-suspend', 20, 'suspend', 'collections.suspend', 'Suspend non-essential services (human confirms).', null, 3),
  ('col-evict', 45, 'evict', 'collections.evict', 'Begin eviction (regulated, human-only).', null, 4);
