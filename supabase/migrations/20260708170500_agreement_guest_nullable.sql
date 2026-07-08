-- The resident is now modelled as a party in the 'resident' role
-- (agreement_party, migration 20260708170000). The legacy agreement.guest_id
-- stays for backward compatibility but is no longer required — an agreement may
-- identify its resident purely by party. The FK remains, so a non-null guest_id
-- must still reference a real guest.
alter table agreement alter column guest_id drop not null;
