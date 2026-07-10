-- Wire the lease.execute transition: the Agreement aggregate now records a
-- 'lease_executed' event (the regulated, human-approved binding of a lease,
-- distinct from converting the agreement's kind to 'lease'). Widen the
-- agreement_event type check to accept it. Additive + backward-compatible.

alter table agreement_event drop constraint agreement_event_type_check;
alter table agreement_event add constraint agreement_event_type_check
  check (type in ('created','activated','converted','amended','completed','terminated',
                  'party_assigned','party_released','rent_adjusted','transferred',
                  'moved_in','moved_out','lease_executed'));
