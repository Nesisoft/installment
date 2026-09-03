-- ============================================================================
-- 0018_merchant_signup_fields.sql  (What a shop sells, and where it gets paid)
-- ============================================================================
-- Two things the merchant design collects at onboarding and self-signup never
-- asked for: what the shop sells, and the MoMo number every payout goes to.
--
-- The category is a foreign key into `categories`, not a new enum. That table
-- already holds exactly the vocabulary the design lists — Fashion, Electronics,
-- Beauty, Home, Groceries, Kids — and it is what the storefront filters
-- products by. A second list of the same six names would drift within a month
-- and would mean a shop's category could never line up with its products'.
--
-- It lives on `stores` rather than `merchants`: a merchant is a legal entity
-- and a store is the shopfront a buyer sees, and the storefront reads stores.
--
-- There is no column here for the MoMo number. That is the point of the slice:
-- a payout destination is `paystack_recipient_code` + the bank columns that
-- 0009 already added, written only by PayoutAccountService after the bank has
-- confirmed who owns the account. A raw number typed into a signup form is not
-- a payout destination, and giving it a column would make it look like one.
--
-- Conventions carried forward unchanged: uuid PKs via gen_random_uuid(); TEXT +
-- CHECK instead of enums; timestamptz; updated_at maintained by the shared
-- set_updated_at() trigger from 0000.
-- ============================================================================

BEGIN;

ALTER TABLE stores
  ADD COLUMN primary_category_id UUID REFERENCES categories (id) ON DELETE SET NULL;

COMMENT ON COLUMN stores.primary_category_id IS
  'What the shop mainly sells. A top-level category; enforced in the service, because a FK cannot see parent_id.';

-- Browsing shops by what they sell is the read this exists for, and it is a
-- filter on active stores.
CREATE INDEX stores_primary_category_idx
  ON stores (primary_category_id)
  WHERE deleted_at IS NULL;

COMMIT;
