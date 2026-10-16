-- ============================================================================
-- 0023_merchant_commission_override.sql  (A negotiable pay-now commission)
-- ============================================================================
-- A paid-in-full order takes the marketplace commission: checkout stamps
-- `DEFAULT_MARKETPLACE_COMMISSION_BPS` (500, 5%) onto `orders.commission_bps`
-- and `confirmPayment` books it. That constant was the only input, so no
-- merchant could be given a different rate.
--
-- 0009 added `mdr_bps_override` / `reserve_bps_override` for the instalment
-- side. This is the cash-sale counterpart, kept separate on purpose: the MDR
-- prices Ejua fronting the money and carrying the credit risk on a plan; the
-- commission is the marketplace's cut of a sale it never lent against. A deal
-- on one says nothing about the other.
--
-- Same shape as 0009: NULL means "no deal, the platform default applies", a
-- value is a negotiated rate, and 0 is a rate rather than the absence of one.
-- The rate is still snapshotted per order (`orders.commission_bps`), so
-- changing a merchant's terms never reprices an order already placed.
-- ============================================================================

BEGIN;

ALTER TABLE merchants
  ADD COLUMN commission_bps_override INTEGER
    CHECK (commission_bps_override IS NULL
           OR (commission_bps_override >= 0 AND commission_bps_override <= 2000));

COMMENT ON COLUMN merchants.commission_bps_override IS
  'Negotiated marketplace commission on paid-in-full orders, in bps. NULL = the platform default.';

COMMIT;
