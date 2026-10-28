-- ============================================================================
-- 0026_product_takedown.sql  (Staff can take a listing down, and it stays down)
-- ============================================================================
-- Products are `draft`, `active` or `archived`, and the seller sets the status.
-- Staff could archive a counterfeit or prohibited listing through the admin
-- API, and the seller could put it straight back on sale through theirs:
-- nothing recorded that it had been taken down, by whom, or why.
--
-- A takedown archives the product and stamps these columns. While
-- `taken_down_at` is set no one may move the product out of `archived`; the
-- seller can still edit the listing, and staff lift the takedown, which puts
-- the product back in the status it was taken down from.
-- ============================================================================

BEGIN;

ALTER TABLE products
  ADD COLUMN taken_down_at TIMESTAMPTZ,
  ADD COLUMN taken_down_by UUID,
  ADD COLUMN taken_down_reason TEXT,
  ADD COLUMN taken_down_from_status TEXT;

ALTER TABLE products
  ADD CONSTRAINT products_takedown_complete CHECK (
    (taken_down_at IS NULL AND taken_down_reason IS NULL AND taken_down_from_status IS NULL)
    OR (taken_down_at IS NOT NULL AND taken_down_reason IS NOT NULL
        AND taken_down_from_status IS NOT NULL AND status = 'archived')
  );

COMMENT ON COLUMN products.taken_down_at IS
  'Set when staff take the listing down. While set, the product stays archived.';
COMMENT ON COLUMN products.taken_down_reason IS
  'Why it was taken down, shown to the seller.';
COMMENT ON COLUMN products.taken_down_from_status IS
  'The status to return to when the takedown is lifted.';

COMMIT;
