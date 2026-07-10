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
  ('pol-agreement-adjust-rent', 'agreement.adjust_rent', 'allow', 'Scheduled rent adjustments within the lease escalation terms are routine and fully audited.', null, 3),
  ('pol-agreement-transfer', 'agreement.transfer', 'allow', 'Unit transfers within a property preserve the agreement and its ledger; routine.', null, 4),
  ('pol-lease-execute', 'lease.execute', 'escalate', 'Executing a lease in BR/EU is regulated and irreversible: propose to human, never execute.', null, 5),
  ('pol-invoice-issue', 'invoice.issue', 'allow', 'Agents may issue invoices from rate plans.', null, 6),
  ('pol-payment-record', 'payment.record', 'allow', 'Agents may record settled payments (no provider credentials in kernel).', null, 7),
  ('pol-payment-refund-large', 'payment.refund', 'escalate', 'Refunds above R$500 require human approval.', 'amount_cents > 50000', 8),
  ('pol-payment-refund', 'payment.refund', 'allow', 'Small refunds are routine.', null, 9),
  ('pol-deposit-hold', 'deposit.hold', 'allow', 'Agents may take security deposits per rate plan.', null, 10),
  ('pol-deposit-refund', 'deposit.refund', 'allow', 'Deposit refunds with itemized deductions are routine.', null, 11),
  ('pol-amenity-charge', 'amenity.charge', 'allow', 'Agents may post catalog amenity charges.', null, 12),
  ('pol-nfe-ingest', 'nfe.ingest', 'allow', 'Agents may ingest supplier NF-e documents into AP.', null, 13),
  ('pol-bill-issue', 'bill.issue', 'allow', 'Agents may record vendor bills and resident refunds into accounts payable.', null, 14),
  ('pol-bill-pay-large', 'bill.pay', 'escalate', 'Paying more than R$5,000 out requires human approval (money leaves the business).', 'amount_cents > 500000', 15),
  ('pol-bill-pay', 'bill.pay', 'allow', 'Routine payables settlement is auto-approved; real bank-rail payout (a future integration) will tighten this.', null, 16),
  ('pol-po-raise', 'purchase_order.raise', 'allow', 'Raising a draft purchase order commits nothing to the ledger; routine.', null, 17),
  ('pol-po-approve-large', 'purchase_order.approve', 'escalate', 'Approving a purchase order above R$5,000 commits significant spend: human approval required.', 'amount_cents > 500000', 18),
  ('pol-po-approve', 'purchase_order.approve', 'allow', 'Approving a routine purchase order encumbers budget; auto-approved under the threshold.', null, 19),
  ('pol-po-receive', 'purchase_order.receive', 'allow', 'Recording receipt of goods/services against a PO is routine.', null, 20),
  ('pol-po-close', 'purchase_order.close', 'allow', 'Closing a fulfilled or abandoned PO releases its commitment; routine.', null, 21),
  ('pol-po-cancel', 'purchase_order.cancel', 'allow', 'Cancelling an unbilled purchase order is routine.', null, 22),
  ('pol-workorder-open', 'work_order.open', 'allow', 'Agents may raise maintenance work orders.', null, 23),
  ('pol-workorder-update', 'work_order.update', 'allow', 'Assigning a vendor and starting work are routine.', null, 24),
  ('pol-workorder-close', 'work_order.close', 'allow', 'Completing or cancelling a work order is routine.', null, 25),
  ('pol-reservation-create', 'reservation.create', 'allow', 'Reserving a bookable common area or amenity is routine.', null, 26),
  ('pol-reservation-cancel', 'reservation.cancel', 'allow', 'Cancelling a reservation and freeing the slot is routine.', null, 27),
  ('pol-agreement-move', 'agreement.move', 'allow', 'Recording move-in / move-out is routine front-desk activity.', null, 28),
  ('pol-inspection-create', 'inspection.create', 'allow', 'Scheduling a move-in/out inspection (vistoria) is routine.', null, 29),
  ('pol-inspection-complete', 'inspection.complete', 'allow', 'Recording an inspection checklist and damage estimate is routine.', null, 30),
  ('pol-inspection-cancel', 'inspection.cancel', 'allow', 'Cancelling a scheduled inspection is routine.', null, 31),
  ('pol-comms-open', 'comms.open', 'allow', 'Opening a resident/finance/internal conversation is routine.', null, 32),
  ('pol-comms-send', 'comms.send', 'allow', 'Sending a message (incl. agent-drafted) is routine day-to-day communication.', null, 33),
  ('pol-comms-resolve', 'comms.resolve', 'allow', 'Resolving/reopening a conversation is routine.', null, 34),
  ('pol-recon-import', 'recon.import', 'allow', 'Importing bank transactions for reconciliation is routine.', null, 35),
  ('pol-recon-match', 'recon.match', 'allow', 'Matching a bank line to a payment is routine; it links, it does not move money.', null, 36),
  ('pol-integration-configure', 'integration.configure', 'allow', 'Configuring an integration (non-secret settings; credentials live in the secret store) is routine admin.', null, 37),
  ('pol-connector-dispatch', 'connector.dispatch', 'allow', 'Enqueuing a connector command (unlock, push inventory, pull leads) is routine; edge adapters hold the credentials.', null, 38),
  ('pol-esign-send', 'esign.send', 'allow', 'Sending a lease document out for e-signature is routine and audited; it does not execute the lease (lease.execute stays human-gated).', null, 39),
  ('pol-collections-remind', 'collections.remind', 'allow', 'Payment reminders are routine.', null, 40),
  ('pol-collections-latefee', 'collections.late_fee', 'allow', 'Contractual late fees are routine.', null, 41),
  ('pol-collections-suspend', 'collections.suspend', 'escalate', 'Service suspension is guest-impacting: human confirms.', null, 42),
  ('pol-collections-evict', 'collections.evict', 'escalate', 'Eviction is irreversible and regulated: propose to human, never execute.', null, 43),
  ('pol-groupblock-create', 'group_block.create', 'allow', 'Agents may place group blocks.', null, 44),
  ('pol-groupblock-pickup', 'group_block.pickup', 'allow', 'Agents may convert block holds into agreements.', null, 45);

delete from collection_stage;
insert into collection_stage (id, min_days_overdue, action, policy_action, description, fee_bps, ordinal) values
  ('col-remind-1', 1, 'remind', 'collections.remind', 'Friendly reminder, 1 day overdue.', null, 0),
  ('col-remind-2', 7, 'remind', 'collections.remind', 'Second reminder, 1 week overdue.', null, 1),
  ('col-latefee', 10, 'late_fee', 'collections.late_fee', 'Assess 2% contractual late fee.', 200, 2),
  ('col-suspend', 20, 'suspend', 'collections.suspend', 'Suspend non-essential services (human confirms).', null, 3),
  ('col-evict', 45, 'evict', 'collections.evict', 'Begin eviction (regulated, human-only).', null, 4);
