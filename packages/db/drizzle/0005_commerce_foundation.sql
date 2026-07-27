-- ============================================================================
-- 0005_commerce_foundation.sql  (Phase 11 — Commerce Foundation)
-- ============================================================================
-- Adds the e-commerce catalog layer that sits ON TOP of the installment engine
-- (see docs/PLATFORM-ROADMAP.md, docs/design/commerce-domain.md). None of the
-- engine tables change. At checkout (Phase 12) an internal `orders` row's id is
-- handed to the engine as `applications.order_reference`, so partners keep
-- integrating unchanged while the marketplace becomes a first-party consumer.
--
-- Tables: categories, stores, products, product_variants, product_images,
--         inventory, product_plan_offers.
-- Money is always integer pesewas (BIGINT), currency GHS — same rule as the
-- engine. updated_at is maintained by the shared set_updated_at() trigger
-- (defined in 0000). No financial rows here, so no append-only triggers.
-- ============================================================================

BEGIN;

-- --------------------------------------------------------------------- categories
-- Marketplace-wide taxonomy, admin-curated (moderation). Self-referential tree.
CREATE TABLE categories (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id     UUID REFERENCES categories (id) ON DELETE SET NULL,
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  position      INTEGER NOT NULL DEFAULT 0,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE INDEX categories_parent_idx ON categories (parent_id);
CREATE INDEX categories_active_idx ON categories (is_active) WHERE is_active = TRUE;

-- ------------------------------------------------------------------------- stores
-- A merchant's public storefront. 1 store per merchant for v1 (UNIQUE merchant_id),
-- modelled so multi-store is a later relaxation. Reuses `merchants` for KYC /
-- banking / payout — a store is the merchant's public face.
CREATE TABLE stores (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id   UUID NOT NULL UNIQUE REFERENCES merchants (id) ON DELETE CASCADE,
  slug          TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  about         TEXT,
  logo_key      TEXT,                         -- object-storage key (StorageService)
  banner_key    TEXT,
  support_email CITEXT,
  support_phone TEXT,
  status        TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'suspended')),
  policies      JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ,
  CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')
);
CREATE INDEX stores_status_idx ON stores (status) WHERE status = 'active';

-- ----------------------------------------------------------------------- products
-- `merchant_id` is denormalised (via the store) so the checkout → engine hand-off
-- and settlement never need a join. `search_tsv` is a generated FTS vector.
CREATE TABLE products (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id           UUID NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  merchant_id        UUID NOT NULL REFERENCES merchants (id) ON DELETE CASCADE,
  category_id        UUID REFERENCES categories (id) ON DELETE SET NULL,
  title              TEXT NOT NULL,
  description        TEXT,
  status             TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'archived')),
  base_price_pesewas BIGINT NOT NULL CHECK (base_price_pesewas >= 0),
  currency           TEXT NOT NULL DEFAULT 'GHS' CHECK (currency = 'GHS'),
  attributes         JSONB NOT NULL DEFAULT '{}'::jsonb,
  search_tsv         TSVECTOR GENERATED ALWAYS AS (
                       setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
                       setweight(to_tsvector('english', coalesce(description, '')), 'B')
                     ) STORED,
  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at         TIMESTAMPTZ
);
CREATE INDEX products_store_idx ON products (store_id);
CREATE INDEX products_merchant_idx ON products (merchant_id);
CREATE INDEX products_category_idx ON products (category_id);
CREATE INDEX products_active_idx ON products (status) WHERE status = 'active';
CREATE INDEX products_search_idx ON products USING GIN (search_tsv);

-- --------------------------------------------------------------- product_variants
-- Every product has >= 1 variant (a default one). The variant is what a cart /
-- order line references. price_pesewas NULL means "use the product base price".
CREATE TABLE product_variants (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id     UUID NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  sku            TEXT NOT NULL,
  option_values  JSONB NOT NULL DEFAULT '{}'::jsonb,   -- e.g. {"size":"L","color":"red"}
  price_pesewas  BIGINT CHECK (price_pesewas IS NULL OR price_pesewas >= 0),
  barcode        TEXT,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (product_id, sku)
);
CREATE INDEX product_variants_product_idx ON product_variants (product_id);

-- ---------------------------------------------------------------- product_images
CREATE TABLE product_images (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id   UUID NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  storage_key  TEXT NOT NULL,                  -- object-storage key (StorageService)
  alt_text     TEXT,
  position     INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX product_images_product_idx ON product_images (product_id, position);

-- --------------------------------------------------------------------- inventory
-- One row per variant. quantity_available is sellable-now; quantity_reserved is
-- held for pending orders (checkout reserves, payment/approval commits, cancel/
-- expiry releases — Phase 12). Both non-negative.
CREATE TABLE inventory (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id          UUID NOT NULL UNIQUE REFERENCES product_variants (id) ON DELETE CASCADE,
  quantity_available  INTEGER NOT NULL DEFAULT 0 CHECK (quantity_available >= 0),
  quantity_reserved   INTEGER NOT NULL DEFAULT 0 CHECK (quantity_reserved >= 0),
  restock_threshold   INTEGER NOT NULL DEFAULT 0 CHECK (restock_threshold >= 0),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- --------------------------------------------------------- product_plan_offers
-- Which installment plan_templates a product offers at checkout — powers the
-- "plan selector + live calculator". Absence ⇒ the product is pay-now only.
CREATE TABLE product_plan_offers (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id        UUID NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  plan_template_id  UUID NOT NULL REFERENCES plan_templates (id) ON DELETE CASCADE,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (product_id, plan_template_id)
);
CREATE INDEX product_plan_offers_template_idx ON product_plan_offers (plan_template_id);

-- --------------------------------------------------------------------- triggers
-- Reuse the shared set_updated_at() defined in 0000 for every table with an
-- updated_at column.
CREATE TRIGGER categories_updated_at BEFORE UPDATE ON categories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER stores_updated_at BEFORE UPDATE ON stores
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER products_updated_at BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER product_variants_updated_at BEFORE UPDATE ON product_variants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER inventory_updated_at BEFORE UPDATE ON inventory
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --------------------------------------------------------------------- permissions
-- Catalog RBAC. Admin gets all; the read-only role gets catalog:read. Merchant
-- self-service (a merchant managing only their own store) arrives with merchant
-- auth in a later phase; for now catalog:write is an admin/staff capability.
INSERT INTO permissions (name, description) VALUES
  ('catalog:read',     'Read stores, products, categories, inventory'),
  ('catalog:write',    'Create / update stores, products, variants, images, inventory, plan offers'),
  ('categories:write', 'Manage the marketplace category taxonomy')
ON CONFLICT (name) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
  WHERE r.name = 'admin'
    AND p.name IN ('catalog:read', 'catalog:write', 'categories:write')
ON CONFLICT DO NOTHING;

-- read-only staff (if the role exists) can browse the catalog
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
  WHERE r.name = 'read_only'
    AND p.name = 'catalog:read'
ON CONFLICT DO NOTHING;

COMMIT;
