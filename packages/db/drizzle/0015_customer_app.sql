-- ============================================================================
-- 0015_customer_app.sql  (Phase 14 — Customer mobile app)
-- ============================================================================
-- Everything the Ejua customer app needs that the engine + commerce layer did
-- not already carry. Reconciliation, screen by screen, lives in
-- docs/design/customer-app.md; this file is the schema half of it.
--
-- Conventions carried forward unchanged: uuid PKs via gen_random_uuid(); money
-- as BIGINT pesewas (GHS x 100); TEXT + CHECK instead of enums; timestamptz;
-- updated_at maintained by the shared set_updated_at() trigger from 0000.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. Catalogue: what a product card has to show
-- ============================================================================

-- A "was" price and a deal window. The home screen's flash-deal carousel shows
-- "-N%" and counts down; both were invented client-side because there was
-- nowhere to put them. compare_at is advisory (a strikethrough), never charged.
ALTER TABLE products
  ADD COLUMN compare_at_price_pesewas BIGINT
    CHECK (compare_at_price_pesewas IS NULL OR compare_at_price_pesewas >= 0),
  ADD COLUMN deal_ends_at TIMESTAMPTZ;

-- A strikethrough that is not actually a discount is a lie the UI would tell on
-- every card, so the database refuses it.
ALTER TABLE products
  ADD CONSTRAINT products_compare_at_above_price
    CHECK (compare_at_price_pesewas IS NULL OR compare_at_price_pesewas > base_price_pesewas);

-- A deal window without an end is not a deal; the countdown needs the end.
ALTER TABLE products
  ADD CONSTRAINT products_deal_needs_compare_at
    CHECK (deal_ends_at IS NULL OR compare_at_price_pesewas IS NOT NULL);

CREATE INDEX products_deal_idx ON products (deal_ends_at) WHERE deal_ends_at IS NOT NULL;

-- Artwork and an accent for the home category rail. Categories were name + slug
-- only, so the rail had no way to look like the design.
ALTER TABLE categories
  ADD COLUMN image_key  TEXT,
  ADD COLUMN accent_hex TEXT CHECK (accent_hex IS NULL OR accent_hex ~ '^#[0-9A-Fa-f]{6}$');

-- Where a store trades, and whether ops have vetted it. The vendor screen shows
-- "Accra · Joined 2024" and a VERIFIED pill next to the name.
ALTER TABLE stores
  ADD COLUMN city        TEXT,
  ADD COLUMN region      TEXT,
  ADD COLUMN verified_at TIMESTAMPTZ;

-- ============================================================================
-- 2. Reviews — the star rating on four screens
-- ============================================================================
-- Gated on a delivered order line: one review per line, so a rating is always
-- attached to a purchase that actually arrived. order_item_id is the gate and
-- the uniqueness key; product_id is denormalised because order_items.product_id
-- is ON DELETE SET NULL and a review must outlive a delisted product.
CREATE TABLE product_reviews (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id    UUID NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  store_id      UUID NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  customer_id   UUID NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  order_item_id UUID NOT NULL REFERENCES order_items (id) ON DELETE CASCADE,
  rating        SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title         TEXT,
  body          TEXT,
  status        TEXT NOT NULL DEFAULT 'published'
    CHECK (status IN ('published', 'hidden')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (order_item_id)
);
CREATE INDEX product_reviews_product_idx  ON product_reviews (product_id) WHERE status = 'published';
CREATE INDEX product_reviews_store_idx    ON product_reviews (store_id)   WHERE status = 'published';
CREATE INDEX product_reviews_customer_idx ON product_reviews (customer_id);

-- ============================================================================
-- 3. Wishlist — the product heart and "Saved items"
-- ============================================================================
CREATE TABLE wishlist_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  product_id  UUID NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (customer_id, product_id)
);
CREATE INDEX wishlist_items_customer_idx ON wishlist_items (customer_id, created_at DESC);

-- ============================================================================
-- 4. Search discovery — "TRENDING IN ACCRA"
-- ============================================================================
-- One row per executed search. The trending list is an aggregate over a rolling
-- window, so this table is append-only and prunable; nothing reads an individual
-- row back. customer_id is nullable because the storefront is browsable signed
-- out, and it is ON DELETE SET NULL so erasing a customer does not erase the
-- aggregate their searches contributed to.
CREATE TABLE search_queries (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  term        TEXT NOT NULL,
  normalised  TEXT NOT NULL,   -- lowercased, whitespace-collapsed; what we group by
  city        TEXT,
  customer_id UUID REFERENCES customers (id) ON DELETE SET NULL,
  result_count INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX search_queries_trending_idx ON search_queries (created_at DESC, normalised);
CREATE INDEX search_queries_customer_idx ON search_queries (customer_id, created_at DESC)
  WHERE customer_id IS NOT NULL;

-- ============================================================================
-- 5. Fulfilment: courier vs pickup, and a delivery fee with something behind it
-- ============================================================================
CREATE TABLE pickup_hubs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  region     TEXT NOT NULL,
  city       TEXT NOT NULL,
  area       TEXT,
  detail     TEXT,               -- "Kwame Nkrumah Ave · open till 8pm"
  latitude   NUMERIC(9, 6),
  longitude  NUMERIC(9, 6),
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX pickup_hubs_city_idx ON pickup_hubs (city, position) WHERE is_active;

-- What courier delivery costs and how long it takes, by place. A NULL city is
-- the region-wide fallback; a row with both NULL is the national fallback, which
-- is what makes a quote always answerable.
CREATE TABLE delivery_zones (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  region            TEXT,
  city              TEXT,
  fee_pesewas       BIGINT NOT NULL CHECK (fee_pesewas >= 0),
  eta_min_days      SMALLINT NOT NULL CHECK (eta_min_days >= 0),
  eta_max_days      SMALLINT NOT NULL CHECK (eta_max_days >= eta_min_days),
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- A city cannot be named without its region, or the fallback ordering
  -- (city match → region match → national) has no way to resolve.
  CONSTRAINT delivery_zones_city_needs_region CHECK (city IS NULL OR region IS NOT NULL)
);
-- One active rate per place. NULLS NOT DISTINCT so the region-wide and national
-- fallbacks are unique too — without it, two national fallbacks could coexist
-- and a quote would depend on row order.
CREATE UNIQUE INDEX delivery_zones_place_idx
  ON delivery_zones (region, city) NULLS NOT DISTINCT WHERE is_active;

ALTER TABLE orders
  ADD COLUMN fulfilment_method TEXT NOT NULL DEFAULT 'courier'
    CHECK (fulfilment_method IN ('courier', 'pickup')),
  ADD COLUMN pickup_hub_id UUID REFERENCES pickup_hubs (id) ON DELETE SET NULL,
  ADD COLUMN return_window_days SMALLINT NOT NULL DEFAULT 7
    CHECK (return_window_days >= 0),
  ADD COLUMN delivered_at TIMESTAMPTZ,
  ADD COLUMN return_window_ends_at TIMESTAMPTZ;

-- A pickup order with no hub, or a courier order carrying one, is a checkout bug
-- we would rather fail on write than render.
ALTER TABLE orders
  ADD CONSTRAINT orders_pickup_needs_hub
    CHECK ((fulfilment_method = 'pickup') = (pickup_hub_id IS NOT NULL));

-- ============================================================================
-- 6. Order lifecycle events — the tracking timeline
-- ============================================================================
-- audit_events already records who changed what for compliance. This is the
-- customer-facing sibling: an append-only, ordered, human-readable history of an
-- order, safe to hand to the app. Keeping them separate means the tracking
-- screen can never leak an internal actor id or a staff note.
CREATE TABLE order_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    UUID NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL,      -- 'order.created', 'order.shipped', …
  status      TEXT,               -- the orders.status the order moved to, when it moved
  label       TEXT NOT NULL,      -- customer-readable: "Shipped from Osu"
  detail      TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX order_events_order_idx ON order_events (order_id, occurred_at);

-- ============================================================================
-- 7. Shipments — courier, tracking code, ETA
-- ============================================================================
CREATE TABLE shipments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       UUID NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  courier_name   TEXT,
  courier_phone  TEXT,
  rider_name     TEXT,
  tracking_code  TEXT,
  status         TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'dispatched', 'in_transit', 'out_for_delivery', 'delivered', 'failed', 'returned')),
  eta_at         TIMESTAMPTZ,
  shipped_at     TIMESTAMPTZ,
  delivered_at   TIMESTAMPTZ,
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (order_id)
);
CREATE INDEX shipments_status_idx ON shipments (status);

-- ============================================================================
-- 8. Late fees — making the promised terms real
-- ============================================================================
-- plan_templates.late_fee_pesewas was a flat amount that was never copied onto a
-- plan, and installment_schedule.late_fee_pesewas was read in five places and
-- written in none. The design and the business proposal both promise "3-day
-- grace, then 2% per week, capped at 15%", so the rate and the cap become real
-- columns and LateFeeCron accrues onto them. Collection already worked: a charge
-- takes amount_due + late_fee.
--
-- Rates stay on the plan as well as the template because a plan is a contract:
-- repricing a template must not reprice the loans already sold under it.
ALTER TABLE plan_templates
  ADD COLUMN late_fee_bps_per_week INTEGER NOT NULL DEFAULT 0
    CHECK (late_fee_bps_per_week >= 0 AND late_fee_bps_per_week <= 10000),
  ADD COLUMN late_fee_cap_bps INTEGER NOT NULL DEFAULT 0
    CHECK (late_fee_cap_bps >= 0 AND late_fee_cap_bps <= 10000);

ALTER TABLE customer_plans
  ADD COLUMN late_fee_bps_per_week INTEGER NOT NULL DEFAULT 0
    CHECK (late_fee_bps_per_week >= 0 AND late_fee_bps_per_week <= 10000),
  ADD COLUMN late_fee_cap_bps INTEGER NOT NULL DEFAULT 0
    CHECK (late_fee_cap_bps >= 0 AND late_fee_cap_bps <= 10000),
  -- The debit sweep was unconditional; the Installments screen offers a switch.
  -- Default TRUE: a plan is sold on the promise that it collects itself.
  ADD COLUMN autopay_enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- When the accrual last ran for a row, so a re-run on the same day is a no-op
-- rather than a second week's fee.
ALTER TABLE installment_schedule
  ADD COLUMN late_fee_accrued_at TIMESTAMPTZ;

-- ============================================================================
-- 9. Credit standing the customer can see
-- ============================================================================
-- credit_profiles is an immutable decision record — one row per scoring run — so
-- a running counter cannot live there. This is the mutable, per-customer view:
-- one row, updated as installments settle, and the source of the Wallet screen's
-- "ON TIME 11 / 11" and the limit bar.
CREATE TABLE customer_credit_standing (
  customer_id            UUID PRIMARY KEY REFERENCES customers (id) ON DELETE CASCADE,
  approved_limit_pesewas BIGINT NOT NULL DEFAULT 0 CHECK (approved_limit_pesewas >= 0),
  on_time_payments       INTEGER NOT NULL DEFAULT 0 CHECK (on_time_payments >= 0),
  late_payments          INTEGER NOT NULL DEFAULT 0 CHECK (late_payments >= 0),
  last_decision_id       UUID REFERENCES credit_profiles (id) ON DELETE SET NULL,
  limit_reviewed_at      TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- 10. Push devices
-- ============================================================================
-- Registration only. NotificationService is still SMS-only; this is where the
-- push transport will read its tokens from when it lands.
CREATE TABLE push_devices (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id  UUID NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  expo_token   TEXT NOT NULL UNIQUE,
  platform     TEXT NOT NULL CHECK (platform IN ('android', 'ios', 'web')),
  app_version  TEXT,
  device_name  TEXT,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX push_devices_customer_idx ON push_devices (customer_id) WHERE is_active;

-- ============================================================================
-- 11. Triggers
-- ============================================================================
CREATE TRIGGER product_reviews_updated_at BEFORE UPDATE ON product_reviews
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER pickup_hubs_updated_at BEFORE UPDATE ON pickup_hubs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER delivery_zones_updated_at BEFORE UPDATE ON delivery_zones
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER shipments_updated_at BEFORE UPDATE ON shipments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER customer_credit_standing_updated_at BEFORE UPDATE ON customer_credit_standing
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER push_devices_updated_at BEFORE UPDATE ON push_devices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- 12. Seed: the fallbacks a quote needs to always be answerable
-- ============================================================================
-- Ghana-wide courier fallback, then Greater Accra and Ashanti at the design's
-- GHS 15. Without at least the national row, a delivery quote for an
-- unrecognised city has no answer and checkout cannot price itself.
INSERT INTO delivery_zones (region, city, fee_pesewas, eta_min_days, eta_max_days) VALUES
  (NULL,            NULL,     2500, 3, 7),
  ('Greater Accra', NULL,     1500, 1, 3),
  ('Greater Accra', 'Accra',  1500, 1, 3),
  ('Ashanti',       NULL,     2000, 2, 4),
  ('Ashanti',       'Kumasi', 2000, 2, 4);

COMMIT;
