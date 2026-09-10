-- ============================================================================
-- 0022_order_delivery_snapshot.sql  (Where an order actually went)
-- ============================================================================
-- `orders.shipping_address_id` is a live foreign key into `addresses`, and the
-- seller's order screen resolves the delivery block by re-reading that row at
-- render time. Nothing is copied onto the order. Two consequences, both of
-- which the shopper causes and neither of which they could possibly intend:
--
--   * EDITING a saved address silently rewrites the delivery block of every
--     order that points at it. Correcting "Adenta" to "Adenta East" on your
--     address book changes where a parcel delivered last month says it went.
--
--   * DELETING one blanks it. The FK is `ON DELETE SET NULL`, so the order
--     keeps existing with no address at all and `deliveryFor` falls through to
--     its all-null `empty` — for an order that may still be sitting in
--     `fulfilling`, waiting for the seller to put it on a van.
--
-- Neither is reachable from a client today only because no client offers edit
-- or delete: five of the six address routes have no caller. The address book
-- screen is what makes them reachable, so the snapshot goes in first.
--
-- A delivery address is a historical fact about an order, in the same way
-- `order_items.title` and `order_items.unit_price_pesewas` are: both were
-- snapshotted at 0006 for exactly this reason — a product renamed or repriced
-- must not rewrite what somebody bought.
--
-- One JSONB column rather than seven text ones. The shape is the address's
-- own, it is written once and read whole, and no query filters or joins on
-- its parts — a pickup order has none of them, and the seven-column version
-- would be seven nullable columns that only ever move together.
--
-- Conventions carried forward: timestamptz, no enums, `set_updated_at()` from
-- 0000 already covers `orders`.
-- ============================================================================

BEGIN;

ALTER TABLE orders
  ADD COLUMN delivery_address JSONB;

COMMENT ON COLUMN orders.delivery_address IS
  'The shipping address as it stood when the order was placed: {recipient, phone, region, city, area, landmark, ghanapost_gps}. NULL for pickup orders and for orders placed before 0022. Immutable — editing or deleting the source address must not change it.';

-- Backfill from the live row where one still exists. Orders whose address has
-- already been deleted cannot be recovered; they keep a NULL and the read path
-- falls back the way it always did.
UPDATE orders o
SET delivery_address = jsonb_strip_nulls(jsonb_build_object(
      'recipient',     a.recipient,
      'phone',         a.phone,
      'region',        a.region,
      'city',          a.city,
      'area',          a.area,
      'landmark',      a.landmark,
      'ghanapost_gps', a.ghanapost_gps
    ))
FROM addresses a
WHERE o.shipping_address_id = a.id
  AND o.delivery_address IS NULL;

COMMIT;
