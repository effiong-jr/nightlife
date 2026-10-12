-- New payout statuses for settlement, in their own migration: Postgres won't
-- let a new enum value be used (e.g. in an index) in the transaction that adds it.
--   held        waiting for the payee's payout account (or below the minimum)
--   transferred money is in the payee's Connect account; bank payout next
alter type public.payout_status add value 'held' before 'pending';
alter type public.payout_status add value 'transferred' after 'pending';
