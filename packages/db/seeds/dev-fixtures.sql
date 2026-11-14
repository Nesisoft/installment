-- ============================================================================
-- dev-fixtures.sql
-- ============================================================================
-- Dev / test-only user rows. Never run in production — these IDs are reserved
-- per DEVELOPMENT-PLAN.md §3.1 (SEED_ADMIN in the 00..0099 slot, FIXTURE_*
-- in the aaaaaaaa-...-prefixed range). Re-applies safely thanks to ON CONFLICT.
-- ============================================================================

-- Dev password for the back-office fixtures is "password123" (bcrypt, 12 rounds).
-- Customers authenticate via phone OTP, so Ama has no password.
INSERT INTO users (id, email, name, user_type, is_active, password_hash) VALUES
  ('00000000-0000-0000-0000-000000000099', 'seed-admin@installment.local',     'Seed Admin',         'admin',    TRUE, '$2a$12$PHFQt1.YVXidunA0IRa9ZO/KlZbxrr3YgO8yfuplkX1hPaLkZ1WWy'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-000000000001', 'jane.admin@fixture.local',         'Fixture: Admin Jane', 'admin',    TRUE, '$2a$12$PHFQt1.YVXidunA0IRa9ZO/KlZbxrr3YgO8yfuplkX1hPaLkZ1WWy'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-000000000002', 'kofi.agent@fixture.local',         'Fixture: Agent Kofi', 'agent',    TRUE, '$2a$12$PHFQt1.YVXidunA0IRa9ZO/KlZbxrr3YgO8yfuplkX1hPaLkZ1WWy'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-000000000003', 'ama.customer@fixture.local',       'Fixture: Customer Ama','customer', TRUE, NULL)
ON CONFLICT (id) DO NOTHING;

-- Backfill the dev password for fixtures created by an earlier seed (the INSERT
-- above no-ops on existing ids). Lets you sign into the back-office apps without
-- a full db:reset. password: "password123".
UPDATE users SET password_hash = '$2a$12$PHFQt1.YVXidunA0IRa9ZO/KlZbxrr3YgO8yfuplkX1hPaLkZ1WWy'
  WHERE id IN (
    '00000000-0000-0000-0000-000000000099',
    'aaaaaaaa-aaaa-aaaa-aaaa-000000000001',
    'aaaaaaaa-aaaa-aaaa-aaaa-000000000002'
  )
  AND password_hash IS NULL;

-- Grant the admin role to the two admin fixtures (and SEED_ADMIN).
INSERT INTO user_roles (user_id, role_id)
  SELECT u.id, r.id
  FROM users u CROSS JOIN roles r
  WHERE u.id IN (
    '00000000-0000-0000-0000-000000000099',
    'aaaaaaaa-aaaa-aaaa-aaaa-000000000001'
  )
  AND r.name = 'admin'
ON CONFLICT DO NOTHING;

-- Agent fixture -> ops role.
INSERT INTO user_roles (user_id, role_id)
  SELECT u.id, r.id
  FROM users u CROSS JOIN roles r
  WHERE u.id = 'aaaaaaaa-aaaa-aaaa-aaaa-000000000002' AND r.name = 'ops'
ON CONFLICT DO NOTHING;

-- Customer fixture -> customer role.
INSERT INTO user_roles (user_id, role_id)
  SELECT u.id, r.id
  FROM users u CROSS JOIN roles r
  WHERE u.id = 'aaaaaaaa-aaaa-aaaa-aaaa-000000000003' AND r.name = 'customer'
ON CONFLICT DO NOTHING;

-- ============================================================================
-- Sample merchant + linked merchant-owner login for the /merchant portal (dev).
-- Sign in to the seller app with merchant@demo.local / password123. The /merchant
-- routes are scoped via users.metadata.merchant_id (see MerchantScopeGuard).
-- ============================================================================
INSERT INTO merchants (id, business_name, legal_name, email, phone, status) VALUES
  (
    'bbbbbbbb-bbbb-bbbb-bbbb-000000000001',
    'Demo Electronics',
    'Demo Electronics Ltd',
    'shop@demo.local',
    '+233200000001',
    'active'
  )
ON CONFLICT (id) DO NOTHING;

INSERT INTO users (id, email, name, user_type, is_active, password_hash, metadata) VALUES
  (
    'bbbbbbbb-bbbb-bbbb-bbbb-0000000000a1',
    'merchant@demo.local',
    'Demo Merchant',
    'merchant',
    TRUE,
    '$2a$12$PHFQt1.YVXidunA0IRa9ZO/KlZbxrr3YgO8yfuplkX1hPaLkZ1WWy',
    '{"merchant_id":"bbbbbbbb-bbbb-bbbb-bbbb-000000000001"}'::jsonb
  )
ON CONFLICT (id) DO NOTHING;

-- Backfill password + merchant link for a merchant login from an earlier seed.
UPDATE users SET
    password_hash = '$2a$12$PHFQt1.YVXidunA0IRa9ZO/KlZbxrr3YgO8yfuplkX1hPaLkZ1WWy',
    metadata = '{"merchant_id":"bbbbbbbb-bbbb-bbbb-bbbb-000000000001"}'::jsonb
  WHERE id = 'bbbbbbbb-bbbb-bbbb-bbbb-0000000000a1' AND password_hash IS NULL;

INSERT INTO user_roles (user_id, role_id)
  SELECT u.id, r.id
  FROM users u CROSS JOIN roles r
  WHERE u.id = 'bbbbbbbb-bbbb-bbbb-bbbb-0000000000a1' AND r.name = 'merchant_owner'
ON CONFLICT DO NOTHING;

-- ============================================================================
-- Sample customer + linked login for the /me customer app (dev).
-- Sign in to customer-web with phone 024 000 0002 — SMS_PROVIDER=console prints
-- the OTP to the API log. A `customers` row AND users.phone are both required:
-- OTP login resolves the user by phone, and /me/* resolves the domain customer
-- via customers.user_id.
-- ============================================================================
-- The card fields have to agree with each other: 0019 added a CHECK that
-- `ghana_card_verified` is true exactly when `ghana_card_status = 'approved'`,
-- and another that a status needs a card number. This fixture used to set
-- `verified` alone, which the first of those now refuses — correctly, because
-- "verified" with no card is a claim about a document that does not exist.
--
-- The image key points at an object dev storage does not hold. That is
-- deliberate: it exercises the admin console's missing-scan fallback, which is
-- the state a reviewer sees when a key is dangling.
INSERT INTO customers (
  id, first_name, last_name, email, phone, date_of_birth, momo_phone, momo_provider,
  kyc_tier, ghana_card_number, ghana_card_image_key,
  ghana_card_verified, ghana_card_verified_at, ghana_card_status, ghana_card_reviewed_at,
  user_id, data_processing_consent_at, credit_scoring_consent_at
) VALUES (
  'cccccccc-cccc-cccc-cccc-000000000001',
  'Ama', 'Mensah',
  'ama.shopper@demo.local',
  '+233240000002',
  '1995-06-15',
  '+233240000002',
  'mtn',
  1,
  'GHA-000000001-0',
  'kyc/cccccccc-cccc-cccc-cccc-000000000001/ghana-card-demo.jpg',
  TRUE, NOW(), 'approved', NOW(),
  'aaaaaaaa-aaaa-aaaa-aaaa-000000000003',
  NOW(), NOW()
)
ON CONFLICT (id) DO NOTHING;

-- Backdate the phone so the scoring engine's `gate.phone_age` hard gate passes.
-- A number first seen "just now" is a fraud signal, so a freshly-seeded customer
-- is declined outright — which makes the demo look broken rather than strict.
UPDATE customers
   SET phone_first_seen_at = NOW() - INTERVAL '400 days'
 WHERE id = 'cccccccc-cccc-cccc-cccc-000000000001'
   AND phone_first_seen_at > NOW() - INTERVAL '30 days';

-- `gate.age_range` declines an unknown age, so the demo customer needs a DOB.
UPDATE customers
   SET date_of_birth = '1995-06-15'
 WHERE id = 'cccccccc-cccc-cccc-cccc-000000000001'
   AND date_of_birth IS NULL;

-- The OTP login path looks the user up by phone, so the login row needs one.
UPDATE users
   SET phone = '+233240000002'
 WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-000000000003'
   AND phone IS NULL;

-- Re-link if an earlier seed created the customer without the login link.
UPDATE customers
   SET user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-000000000003'
 WHERE id = 'cccccccc-cccc-cccc-cccc-000000000001'
   AND user_id IS NULL;

-- ============================================================================
-- Demo catalogue for the customer shopping app (dev): a plan offer, a category,
-- Demo Electronics' storefront, and one purchasable product with stock. Enough
-- to walk browse → cart → instalment checkout end to end.
-- ============================================================================
INSERT INTO plan_templates (
  id, name, description, business_model, number_of_installments,
  installment_frequency_days, down_payment_bps, interest_rate_bps,
  service_fee_flat_pesewas, late_fee_pesewas, grace_period_days,
  min_amount_pesewas, max_amount_pesewas, is_active
) VALUES (
  'dddddddd-dddd-dddd-dddd-000000000001',
  'Pay in 4 (weekly)',
  'Four weekly payments, no interest.',
  'bnpl', 4, 7,
  0, 0, 0, 500, 3,
  10000, 5000000,
  TRUE
)
ON CONFLICT (id) DO NOTHING;

-- Inserted flat because Electronics does not exist yet: this file runs before
-- marketplace-demo.sql, which defines the top-level taxonomy and is where these
-- two are parented under it. Nothing here should treat them as top-level.
INSERT INTO categories (id, name, slug, position, is_active) VALUES
  ('dddddddd-dddd-dddd-dddd-00000000c001', 'Phones', 'phones', 1, TRUE),
  ('dddddddd-dddd-dddd-dddd-00000000c002', 'Laptops', 'laptops', 2, TRUE)
ON CONFLICT (id) DO NOTHING;

INSERT INTO stores (id, merchant_id, slug, display_name, about, status) VALUES (
  'dddddddd-dddd-dddd-dddd-00000000a001',
  'bbbbbbbb-bbbb-bbbb-bbbb-000000000001',
  'demo-electronics',
  'Demo Electronics',
  'Phones and laptops on flexible payment plans.',
  'active'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO products (
  id, store_id, merchant_id, category_id, title, description, status, base_price_pesewas
) VALUES (
  'dddddddd-dddd-dddd-dddd-00000000b001',
  'dddddddd-dddd-dddd-dddd-00000000a001',
  'bbbbbbbb-bbbb-bbbb-bbbb-000000000001',
  'dddddddd-dddd-dddd-dddd-00000000c001',
  'Demo Smartphone X',
  'A demo phone for testing the installment checkout flow.',
  'active',
  120000
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO product_variants (id, product_id, sku, option_values, price_pesewas, is_active) VALUES
  (
    'dddddddd-dddd-dddd-dddd-00000000e001',
    'dddddddd-dddd-dddd-dddd-00000000b001',
    'DEMO-PHONE-X-128',
    '{"storage":"128GB"}'::jsonb,
    120000,
    TRUE
  )
ON CONFLICT (id) DO NOTHING;

INSERT INTO inventory (variant_id, quantity_available, quantity_reserved, restock_threshold) VALUES
  ('dddddddd-dddd-dddd-dddd-00000000e001', 25, 0, 5)
ON CONFLICT (variant_id) DO NOTHING;

INSERT INTO product_plan_offers (product_id, plan_template_id, is_active) VALUES
  (
    'dddddddd-dddd-dddd-dddd-00000000b001',
    'dddddddd-dddd-dddd-dddd-000000000001',
    TRUE
  )
ON CONFLICT DO NOTHING;
