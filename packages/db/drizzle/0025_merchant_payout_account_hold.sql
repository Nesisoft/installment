-- ============================================================================
-- 0025_merchant_payout_account_hold.sql  (A new payout account waits a day)
-- ============================================================================
-- A merchant could replace their payout account from the portal with nothing
-- but a signed-in session: no code to the phone on file, no notice, and the
-- next settlement run paid the new account at once. Whoever held the session —
-- a shared tablet, a borrowed laptop, a stolen password — could redirect every
-- cedi owed, and the seller learnt of it when the money did not arrive.
--
-- Replacing an existing account now takes a code sent to the merchant's phone,
-- sends a notice to that phone, and sets this column 24 hours ahead. The daily
-- settlement run skips the merchant until it passes, leaving the balance owed:
-- a day for the real seller to see the notice and call before anything moves.
--
-- NULL means no hold. Setting a first account (signup, or a merchant who never
-- had one) sets nothing: there was nowhere else the money was going.
-- ============================================================================

BEGIN;

ALTER TABLE merchants
  ADD COLUMN payout_account_hold_until TIMESTAMPTZ;

COMMENT ON COLUMN merchants.payout_account_hold_until IS
  'Settlement skips the merchant until this time. Set 24h ahead when an existing payout account is replaced; NULL = no hold.';

COMMIT;
