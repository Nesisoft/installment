-- ============================================================================
-- 0006_orders_and_cart.sql  (Phase 12 — Cart, Checkout & Orders)
-- ============================================================================
-- Adds the transactional commerce tables that sit on top of the catalog
-- (0005) and hand to the installment engine at checkout via
-- orders.id AS applications.order_reference (see docs/design/commerce-domain.md
-- §3.2–§3.5, §5). No engine table changes.
--
-- Decisions taken (defaults, docs/design/commerce-domain.md §9):
--   * one order per merchant (a multi-vendor cart splits at checkout)
--   * checkout requires an identified customer (no anonymous guest in v1)
--   * marketplace commission is a per-order take-rate in bps (commission_bps),
--     applied to all orders; the engine's mdr/reserve stay for installment
--     credit risk. Set by the checkout service.
--
-- Money is integer pesewas (BIGINT), currency GHS. updated_at via the shared
-- set_updated_at() trigger (0000).
-- ============================================================================

BEGIN;

-- ------------------------------------------------------------------- addresses
CREATE TABLE addresses (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id    UUID NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  recipient      TEXT NOT NULL,
  phone          TEXT NOT NULL,
  region         TEXT NOT NULL,
  city           TEXT NOT NULL,
  area           TEXT,
  landmark       TEXT,
  ghanapost_gps  TEXT,                              -- GhanaPostGPS digital address
  is_default     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX addresses_customer_idx ON addresses (customer_id);
-- At most one default address per customer.
CREATE UNIQUE INDEX addresses_one_default_idx ON addresses (customer_id) WHERE is_default;

-- ----------------------------------------------------------------------- carts
CREATE TABLE carts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id  UUID NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'converted', 'abandoned')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- One active cart per customer.
CREATE UNIQUE INDEX carts_one_active_idx ON carts (customer_id) WHERE status = 'active';

-- ------------------------------------------------------------------ cart_items
CREATE TABLE cart_items (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id            UUID NOT NULL REFERENCES carts (id) ON DELETE CASCADE,
  variant_id         UUID NOT NULL REFERENCES product_variants (id) ON DELETE CASCADE,
  merchant_id        UUID NOT NULL REFERENCES merchants (id) ON DELETE CASCADE,
  quantity           INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_pesewas BIGINT NOT NULL CHECK (unit_price_pesewas >= 0),  -- snapshot at add-time
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (cart_id, variant_id)
);
CREATE INDEX cart_items_cart_idx ON cart_items (cart_id);

-- --------------------------------------------------------------------- orders
-- One order per merchant. For installment orders, application_id / customer_plan_id
-- link into the engine; for full (pay-now) orders they stay null.
CREATE TABLE orders (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number        TEXT NOT NULL UNIQUE,
  customer_id         UUID NOT NULL REFERENCES customers (id) ON DELETE RESTRICT,
  merchant_id         UUID NOT NULL REFERENCES merchants (id) ON DELETE RESTRICT,
  store_id            UUID NOT NULL REFERENCES stores (id) ON DELETE RESTRICT,
  source              TEXT NOT NULL DEFAULT 'internal'
    CHECK (source IN ('internal', 'partner')),
  payment_type        TEXT NOT NULL CHECK (payment_type IN ('full', 'installment')),
  subtotal_pesewas    BIGINT NOT NULL CHECK (subtotal_pesewas >= 0),
  shipping_pesewas    BIGINT NOT NULL DEFAULT 0 CHECK (shipping_pesewas >= 0),
  discount_pesewas    BIGINT NOT NULL DEFAULT 0 CHECK (discount_pesewas >= 0),
  total_pesewas       BIGINT NOT NULL CHECK (total_pesewas >= 0),
  commission_bps      INTEGER NOT NULL DEFAULT 0 CHECK (commission_bps >= 0 AND commission_bps <= 10000),
  currency            TEXT NOT NULL DEFAULT 'GHS' CHECK (currency = 'GHS'),
  status              TEXT NOT NULL DEFAULT 'pending_payment'
    CHECK (status IN (
      'pending_payment', 'pending_approval', 'paid', 'financing_active',
      'fulfilling', 'shipped', 'delivered', 'completed',
      'cancelled', 'payment_failed', 'declined', 'returned', 'defaulted'
    )),
  shipping_address_id UUID REFERENCES addresses (id) ON DELETE SET NULL,
  application_id      UUID REFERENCES applications (id) ON DELETE SET NULL,
  customer_plan_id    UUID REFERENCES customer_plans (id) ON DELETE SET NULL,
  placed_at           TIMESTAMPTZ,
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX orders_customer_idx ON orders (customer_id);
CREATE INDEX orders_merchant_idx ON orders (merchant_id);
CREATE INDEX orders_status_idx ON orders (status);

-- ----------------------------------------------------------------- order_items
-- Immutable snapshot of what was bought (title / sku kept even if the product or
-- variant is later removed, hence the nullable references).
CREATE TABLE order_items (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           UUID NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  variant_id         UUID REFERENCES product_variants (id) ON DELETE SET NULL,
  product_id         UUID REFERENCES products (id) ON DELETE SET NULL,
  title              TEXT NOT NULL,
  sku                TEXT NOT NULL,
  quantity           INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_pesewas BIGINT NOT NULL CHECK (unit_price_pesewas >= 0),
  line_total_pesewas BIGINT NOT NULL CHECK (line_total_pesewas >= 0),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX order_items_order_idx ON order_items (order_id);

-- --------------------------------------------------------------------- triggers
CREATE TRIGGER addresses_updated_at BEFORE UPDATE ON addresses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER carts_updated_at BEFORE UPDATE ON carts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER cart_items_updated_at BEFORE UPDATE ON cart_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER orders_updated_at BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
