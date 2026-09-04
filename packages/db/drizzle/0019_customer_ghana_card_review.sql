-- ============================================================================
-- 0019_customer_ghana_card_review.sql  (A card the customer can send and track)
-- ============================================================================
-- The customer's Ghana Card has carried one boolean — `ghana_card_verified` —
-- since 0000, while the merchant's KYC documents got a `status`, a reviewer, a
-- timestamp and a `rejection_reason` in 0016. That asymmetry is what blocks the
-- customer app from showing the card's state at all:
--
--   * `rejectGhanaCard` clears `ghana_card_verified` and keeps the number and
--     image key, which is right — they are what was rejected. But it leaves the
--     row byte-identical to "submitted, not yet reviewed", so a customer cannot
--     be told whether to wait or to send a better photo.
--   * The rejection reason exists only in `audit_events`, which the customer
--     cannot read and which is not where a live workflow state belongs.
--
-- So this brings the card up to the shape the merchant document already has.
-- `ghana_card_verified` stays: scoring, `/me/profile` and the admin console all
-- read it, and replacing it would be a wire change for no gain. A CHECK keeps
-- the two in step instead, the same way `merchant_kyc_reviewed_together` in
-- 0016 refuses half a decision.
--
-- Conventions carried forward unchanged: TEXT + CHECK instead of enums;
-- timestamptz; updated_at maintained by the shared set_updated_at() trigger.
-- ============================================================================

BEGIN;

ALTER TABLE customers
  ADD COLUMN ghana_card_status TEXT
    CHECK (ghana_card_status IN ('submitted', 'approved', 'rejected')),
  ADD COLUMN ghana_card_reviewed_by UUID REFERENCES users (id) ON DELETE SET NULL,
  ADD COLUMN ghana_card_reviewed_at TIMESTAMPTZ,
  ADD COLUMN ghana_card_rejection_reason TEXT;

COMMENT ON COLUMN customers.ghana_card_status IS
  'NULL until a card is attached; then submitted -> approved | rejected. Kept in step with ghana_card_verified by a CHECK.';

-- ============================================================================
-- 1. Backfill first, so the CHECKs below can be trusted from the moment they
--    exist rather than validated against rows that predate them
-- ============================================================================

-- A row claiming a verified card with no card number cannot be true: there is
-- no card. Un-verify it rather than invent a number, and take the tier down with
-- it exactly as `rejectGhanaCard` does — the safe direction for a contradiction
-- about identity is always the one that lowers trust. Announced, because
-- silently downgrading somebody's KYC is not something a migration should do
-- without saying so.
DO $$
DECLARE reset_count INT;
BEGIN
  UPDATE customers
     SET ghana_card_verified = FALSE,
         ghana_card_verified_at = NULL,
         kyc_tier = CASE WHEN kyc_tier = 1 THEN 0 ELSE kyc_tier END
   WHERE ghana_card_verified
     AND ghana_card_number IS NULL;
  GET DIAGNOSTICS reset_count = ROW_COUNT;
  IF reset_count > 0 THEN
    RAISE NOTICE '0019: un-verified % customer(s) marked verified with no card number', reset_count;
  END IF;
END $$;

-- A verified card is approved. A card that was attached and never verified is
-- waiting on a reviewer — which is what it has been all along, just unsayable.
UPDATE customers
   SET ghana_card_status = 'approved'
 WHERE ghana_card_verified;

UPDATE customers
   SET ghana_card_status = 'submitted'
 WHERE NOT ghana_card_verified
   AND ghana_card_number IS NOT NULL;

-- ============================================================================
-- 2. A status means there is a card to have a status about
-- ============================================================================
-- The number, and deliberately not the image key. A card is identified by its
-- number; the image is what a reviewer looks at, and `verifyGhanaCard` already
-- refuses to approve without one. Putting the image requirement in the table as
-- well would say that a card can never have been reviewed except by our own
-- current flow — and the first thing this CHECK found was a seeded row that was
-- verified with a number and no scan at all, which is the exact state PR #64
-- existed to fix. The table constrains what must be true of a row; the service
-- constrains what a transition requires.
ALTER TABLE customers
  ADD CONSTRAINT customers_ghana_card_status_needs_card CHECK (
    ghana_card_status IS NULL OR ghana_card_number IS NOT NULL
  );

-- ============================================================================
-- 3. The boolean and the status cannot disagree
-- ============================================================================
-- Two columns for one fact is a bug waiting to be written, so the row refuses to
-- hold a contradiction: `verified` is true exactly when the status is approved.
-- Without this, a future writer that flips one and forgets the other would give
-- the scoring engine and the customer's own screen different answers.
-- `status IS NOT NULL AND ...` rather than the bare comparison, because a CHECK
-- passes when it evaluates to NULL. With a NULL status, `verified = (status =
-- 'approved')` is `true = NULL` -> NULL -> accepted, which would have let
-- through the one row shape this constraint exists to forbid: verified, with no
-- card and no status at all.
ALTER TABLE customers
  ADD CONSTRAINT customers_ghana_card_verified_matches_status CHECK (
    ghana_card_verified = (ghana_card_status IS NOT NULL AND ghana_card_status = 'approved')
  );

-- The review queue reads by status, and it is a small slice of a big table.
CREATE INDEX customers_ghana_card_status_idx
  ON customers (ghana_card_status)
  WHERE ghana_card_status IS NOT NULL AND deleted_at IS NULL;

COMMIT;
