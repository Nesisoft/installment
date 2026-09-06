-- ============================================================================
-- 0021_product_variant_position.sql
-- ============================================================================
-- Gives a product's variants an order.
--
-- `product_variants` has never had one. A product's variants are inserted in a
-- single transaction, so `created_at` is the transaction's start time and is
-- identical for every one of them — which means the only stable ordering
-- available was the primary key, a random uuid. A seller who typed S, M, L, XL
-- got their size chips back in whatever order the uuids happened to sort in.
--
-- Nothing noticed until the merchant app drew them as chips: the admin console
-- and the web portal render one variant per row with its options spelled out,
-- where a scrambled order looks like a list rather than like a mistake. On a
-- card that reads "XL · S · L · M" it looks broken, because it is.
--
-- `product_images` has carried exactly this column since 0000 for exactly this
-- reason, so this is the established shape and not a new idea.
-- ============================================================================

ALTER TABLE product_variants
  ADD COLUMN IF NOT EXISTS position INTEGER NOT NULL DEFAULT 0;

-- Backfill in the only order the existing rows can be put into: by creation,
-- then by id. That is not necessarily the order the seller typed — that
-- information was never recorded and cannot be recovered — but it is stable,
-- and from here on new variants carry the order they were sent in.
WITH ordered AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY product_id
           ORDER BY created_at, id
         ) - 1 AS seq
  FROM product_variants
)
UPDATE product_variants v
   SET position = ordered.seq
  FROM ordered
 WHERE ordered.id = v.id
   AND v.position = 0;

-- Matches `product_images_product_idx`: the read is always "this product's
-- variants, in order".
CREATE INDEX IF NOT EXISTS product_variants_product_position_idx
  ON product_variants (product_id, position);
