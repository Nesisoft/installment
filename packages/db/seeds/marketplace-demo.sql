-- ============================================================================
-- marketplace-demo.sql
-- ============================================================================
-- A shoppable catalogue for the Ejua customer app: stores, categories,
-- products with variants, stock, deals and instalment offers, plus the pickup
-- hubs and the pay-in-4 plan the design is drawn around.
--
-- Dev/demo only. Ids are in the reserved `eeeeeeee-` range so this can be
-- applied on top of dev-fixtures.sql without colliding with it, and every
-- statement is ON CONFLICT-safe so it re-applies cleanly.
--
-- Money is integer pesewas throughout (GHS 320.00 = 32000).
-- ============================================================================

-- ---------------------------------------------------------------- plan terms
-- The design's headline offer: 40% today, then 3 weekly payments. Note the
-- engine's convention — `number_of_installments` EXCLUDES the deposit, so
-- "pay in 4" is 3 instalments plus a down-payment row, and the schedule the
-- generator emits has four rows.
--
-- The late-fee columns are what make "3-day grace, then 2% per week, capped at
-- 15%" a rule rather than a promise: 200 bps/week against a 1500 bps cap.
INSERT INTO plan_templates (
  id, name, description, business_model, number_of_installments,
  installment_frequency_days, down_payment_bps, interest_rate_bps,
  service_fee_flat_pesewas, late_fee_pesewas, late_fee_bps_per_week,
  late_fee_cap_bps, grace_period_days, min_amount_pesewas, max_amount_pesewas,
  is_active
) VALUES
  (
    'eeeeeeee-eeee-eeee-eeee-000000000001',
    'Pay in 4', '40% today, then three weekly payments. No interest.',
    'bnpl', 3, 7, 4000, 0, 0, 0, 200, 1500, 3,
    10000, 5000000, TRUE
  ),
  (
    'eeeeeeee-eeee-eeee-eeee-000000000002',
    'Pay in 6 (fortnightly)', '30% today, then five payments every two weeks.',
    'bnpl', 5, 14, 3000, 0, 0, 0, 200, 1500, 3,
    50000, 8000000, TRUE
  )
ON CONFLICT (id) DO NOTHING;

-- Bring the terms up to date on re-run: an existing template keeps its id but
-- should pick up the late-fee rules this migration made expressible.
UPDATE plan_templates
   SET late_fee_bps_per_week = 200, late_fee_cap_bps = 1500
 WHERE id IN (
         'eeeeeeee-eeee-eeee-eeee-000000000001',
         'eeeeeeee-eeee-eeee-eeee-000000000002',
         'dddddddd-dddd-dddd-dddd-000000000001'
       )
   AND late_fee_bps_per_week = 0;

-- --------------------------------------------------------------- categories
INSERT INTO categories (id, name, slug, position, is_active, accent_hex) VALUES
  ('eeeeeeee-eeee-eeee-eeee-0000000dd001', 'Fashion',     'fashion',     1, TRUE, '#EFE0E4'),
  ('eeeeeeee-eeee-eeee-eeee-0000000dd002', 'Electronics', 'electronics', 2, TRUE, '#DDE3E6'),
  ('eeeeeeee-eeee-eeee-eeee-0000000dd003', 'Beauty',      'beauty',      3, TRUE, '#F0E6DA'),
  ('eeeeeeee-eeee-eeee-eeee-0000000dd004', 'Home',        'home',        4, TRUE, '#E2E7DF'),
  ('eeeeeeee-eeee-eeee-eeee-0000000dd005', 'Groceries',   'groceries',   5, TRUE, '#EFEAD8'),
  ('eeeeeeee-eeee-eeee-eeee-0000000dd006', 'Kids',        'kids',        6, TRUE, '#DFE7EC')
ON CONFLICT (id) DO NOTHING;

-- File Phones and Laptops under Electronics.
--
-- dev-fixtures.sql creates them, and has to: it runs first and its demo product
-- needs a category. Electronics does not exist yet at that point, so they are
-- inserted flat and parented here, where the top-level taxonomy is defined.
--
-- It matters beyond tidiness. Merchant signup asks what a shop sells and offers
-- the top-level categories, so left flat these two show up as shop categories —
-- a seller could file their whole business under "Laptops", which is not one of
-- the six the design offers and is invisible to anyone browsing Electronics.
--
-- Matched by slug rather than by dev-fixtures' uuids, so it holds whoever
-- created the rows, and guarded on `parent_id IS NULL` so a re-run is a no-op
-- and a deliberate re-parenting later is not undone.
UPDATE categories
   SET parent_id = 'eeeeeeee-eeee-eeee-eeee-0000000dd002',
       position  = CASE slug WHEN 'phones' THEN 1 ELSE 2 END
 WHERE slug IN ('phones', 'laptops')
   AND parent_id IS NULL;

-- ---------------------------------------------------------------- merchants
INSERT INTO merchants (id, business_name, legal_name, email, phone, status) VALUES
  ('eeeeeeee-eeee-eeee-eeee-0000000cc001', 'Adepa Couture',   'Adepa Couture Ltd',    'hello@adepa.example',    '+233302000101', 'active'),
  ('eeeeeeee-eeee-eeee-eeee-0000000cc002', 'Osu Tech Hub',    'Osu Tech Hub Ltd',     'hello@osutech.example',  '+233302000102', 'active'),
  ('eeeeeeee-eeee-eeee-eeee-0000000cc003', 'Nkulenu Beauty',  'Nkulenu Beauty Ltd',   'hello@nkulenu.example',  '+233302000103', 'active'),
  ('eeeeeeee-eeee-eeee-eeee-0000000cc004', 'Homevilla GH',    'Homevilla Ghana Ltd',  'hello@homevilla.example','+233302000104', 'active'),
  ('eeeeeeee-eeee-eeee-eeee-0000000cc005', 'Makola Foods',    'Makola Foods Ltd',     'hello@makola.example',   '+233302000105', 'active'),
  ('eeeeeeee-eeee-eeee-eeee-0000000cc006', 'Little Steps',    'Little Steps Ltd',     'hello@littlesteps.example','+233302000106','active')
ON CONFLICT (id) DO NOTHING;

-- ------------------------------------------------------------------- stores
INSERT INTO stores (id, merchant_id, slug, display_name, about, status, city, region, verified_at) VALUES
  ('eeeeeeee-eeee-eeee-eeee-0000000aa001', 'eeeeeeee-eeee-eeee-eeee-0000000cc001', 'adepa-couture',  'ADEPA COUTURE',  'Hand-finished wax print from a small Accra studio.',       'active', 'Accra',  'Greater Accra', NOW()),
  ('eeeeeeee-eeee-eeee-eeee-0000000aa002', 'eeeeeeee-eeee-eeee-eeee-0000000cc002', 'osu-tech-hub',   'OSU TECH HUB',   'Sealed-box phones and TVs with a Ghana warranty.',         'active', 'Accra',  'Greater Accra', NOW()),
  ('eeeeeeee-eeee-eeee-eeee-0000000aa003', 'eeeeeeee-eeee-eeee-eeee-0000000cc003', 'nkulenu-beauty', 'NKULENU BEAUTY', 'Raw Northern shea, black soap and cold-pressed oils.',     'active', 'Accra',  'Greater Accra', NOW()),
  ('eeeeeeee-eeee-eeee-eeee-0000000aa004', 'eeeeeeee-eeee-eeee-eeee-0000000cc004', 'homevilla-gh',   'HOMEVILLA GH',   'Cookers, fridges and small appliances, delivered built.',  'active', 'Accra',  'Greater Accra', NULL),
  ('eeeeeeee-eeee-eeee-eeee-0000000aa005', 'eeeeeeee-eeee-eeee-eeee-0000000cc005', 'makola-foods',   'MAKOLA FOODS',   'Market-fresh staples restocked every Monday.',             'active', 'Accra',  'Greater Accra', NOW()),
  ('eeeeeeee-eeee-eeee-eeee-0000000aa006', 'eeeeeeee-eeee-eeee-eeee-0000000cc006', 'little-steps',   'LITTLE STEPS',   'Prams, car seats and everything for the first three years.','active', 'Kumasi', 'Ashanti',       NULL)
ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------- products
-- deal_ends_at is set relative to NOW() so the home screen's countdown is live
-- whenever the seed is applied, rather than expired the day after it was written.
INSERT INTO products (
  id, store_id, merchant_id, category_id, title, description, status,
  base_price_pesewas, compare_at_price_pesewas, deal_ends_at
) VALUES
  ('eeeeeeee-eeee-eeee-eeee-0000000bb001', 'eeeeeeee-eeee-eeee-eeee-0000000aa001', 'eeeeeeee-eeee-eeee-eeee-0000000cc001', 'eeeeeeee-eeee-eeee-eeee-0000000dd001',
   'Ankara Wrap Dress · Adinkra print',
   'Hand-finished wax print wrap dress from a small Accra studio. Adjustable tie waist, fully lined, machine washable at 30°C. Ships in 24 hours from Makola.',
   'active', 32000, 41000, NULL),
  ('eeeeeeee-eeee-eeee-eeee-0000000bb002', 'eeeeeeee-eeee-eeee-eeee-0000000aa002', 'eeeeeeee-eeee-eeee-eeee-0000000cc002', 'eeeeeeee-eeee-eeee-eeee-0000000dd002',
   'Vivara V30 5G · 256GB Dual SIM',
   '6.7" AMOLED 120Hz, 50MP main camera, 5000mAh with 45W charging. One-year Ghana warranty, sealed box, activated in store before shipping.',
   'active', 289900, 345000, NOW() + INTERVAL '4 hours'),
  ('eeeeeeee-eeee-eeee-eeee-0000000bb003', 'eeeeeeee-eeee-eeee-eeee-0000000aa003', 'eeeeeeee-eeee-eeee-eeee-0000000cc003', 'eeeeeeee-eeee-eeee-eeee-0000000dd003',
   'Shea Glow Ritual Set · 5 pieces',
   'Raw Northern shea butter, black soap, cocoa lip balm, body oil and a sisal sponge. Packed in a reusable cotton bag.',
   'active', 14500, 19000, NULL),
  ('eeeeeeee-eeee-eeee-eeee-0000000bb004', 'eeeeeeee-eeee-eeee-eeee-0000000aa004', 'eeeeeeee-eeee-eeee-eeee-0000000cc004', 'eeeeeeee-eeee-eeee-eeee-0000000dd004',
   'Solara 2-Burner Gas Cooker',
   'Tempered glass top, brass burners, flame-failure cut-off. Includes regulator and hose. Delivered assembled.',
   'active', 89000, 105000, NOW() + INTERVAL '9 hours'),
  ('eeeeeeee-eeee-eeee-eeee-0000000bb005', 'eeeeeeee-eeee-eeee-eeee-0000000aa001', 'eeeeeeee-eeee-eeee-eeee-0000000cc001', 'eeeeeeee-eeee-eeee-eeee-0000000dd001',
   'Court Classic Leather Sneakers',
   'Full-grain leather upper, cupsole, padded collar. True to size. Free exchange within the 7-day return window.',
   'active', 115000, 139000, NULL),
  ('eeeeeeee-eeee-eeee-eeee-0000000bb006', 'eeeeeeee-eeee-eeee-eeee-0000000aa002', 'eeeeeeee-eeee-eeee-eeee-0000000cc002', 'eeeeeeee-eeee-eeee-eeee-0000000dd002',
   '43" Andromeda Smart TV · Frameless',
   'Android TV 12, built-in Netflix and YouTube, 2 HDMI, wall bracket included. Two-year panel warranty.',
   'active', 245000, 299000, NOW() + INTERVAL '6 hours'),
  ('eeeeeeee-eeee-eeee-eeee-0000000bb007', 'eeeeeeee-eeee-eeee-eeee-0000000aa005', 'eeeeeeee-eeee-eeee-eeee-0000000cc005', 'eeeeeeee-eeee-eeee-eeee-0000000dd005',
   'Rice, Oil & Tomato Bundle · 25kg',
   '25kg long-grain rice, 5L frying oil and a case of tomato paste. Restocked every Monday from Makola market.',
   'active', 41000, 47500, NULL),
  ('eeeeeeee-eeee-eeee-eeee-0000000bb008', 'eeeeeeee-eeee-eeee-eeee-0000000aa006', 'eeeeeeee-eeee-eeee-eeee-0000000cc006', 'eeeeeeee-eeee-eeee-eeee-0000000dd006',
   'Little Steps Comfort Stroller',
   'Reclining seat, one-hand fold, all-terrain wheels and a rain cover. Suitable from 6 months to 3 years.',
   'active', 76000, 92000, NULL)
ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------- variants
-- One shared option key per product, which is what gives the picker its single
-- heading (SIZE / STORAGE / SCENT); a product whose variants disagree on keys
-- renders unlabelled chips instead.
INSERT INTO product_variants (id, product_id, sku, option_values, price_pesewas, is_active) VALUES
  ('eeeeeeee-eeee-eeee-eeee-0000000ff101', 'eeeeeeee-eeee-eeee-eeee-0000000bb001', 'ADEPA-WRAP-S',   '{"size":"S"}'::jsonb,        NULL,   TRUE),
  ('eeeeeeee-eeee-eeee-eeee-0000000ff102', 'eeeeeeee-eeee-eeee-eeee-0000000bb001', 'ADEPA-WRAP-M',   '{"size":"M"}'::jsonb,        NULL,   TRUE),
  ('eeeeeeee-eeee-eeee-eeee-0000000ff103', 'eeeeeeee-eeee-eeee-eeee-0000000bb001', 'ADEPA-WRAP-L',   '{"size":"L"}'::jsonb,        NULL,   TRUE),
  ('eeeeeeee-eeee-eeee-eeee-0000000ff201', 'eeeeeeee-eeee-eeee-eeee-0000000bb002', 'VIVARA-V30-128', '{"storage":"128GB"}'::jsonb, 259900, TRUE),
  ('eeeeeeee-eeee-eeee-eeee-0000000ff202', 'eeeeeeee-eeee-eeee-eeee-0000000bb002', 'VIVARA-V30-256', '{"storage":"256GB"}'::jsonb, NULL,   TRUE),
  ('eeeeeeee-eeee-eeee-eeee-0000000ff203', 'eeeeeeee-eeee-eeee-eeee-0000000bb002', 'VIVARA-V30-512', '{"storage":"512GB"}'::jsonb, 329900, TRUE),
  ('eeeeeeee-eeee-eeee-eeee-0000000ff301', 'eeeeeeee-eeee-eeee-eeee-0000000bb003', 'NKULENU-SET-UN', '{"scent":"Unscented"}'::jsonb,  NULL, TRUE),
  ('eeeeeeee-eeee-eeee-eeee-0000000ff302', 'eeeeeeee-eeee-eeee-eeee-0000000bb003', 'NKULENU-SET-LG', '{"scent":"Lemongrass"}'::jsonb, NULL, TRUE),
  ('eeeeeeee-eeee-eeee-eeee-0000000ff401', 'eeeeeeee-eeee-eeee-eeee-0000000bb004', 'SOLARA-2B-STEEL','{"finish":"Steel"}'::jsonb,  NULL,   TRUE),
  ('eeeeeeee-eeee-eeee-eeee-0000000ff402', 'eeeeeeee-eeee-eeee-eeee-0000000bb004', 'SOLARA-2B-BLACK','{"finish":"Black"}'::jsonb,  NULL,   TRUE),
  ('eeeeeeee-eeee-eeee-eeee-0000000ff501', 'eeeeeeee-eeee-eeee-eeee-0000000bb005', 'COURT-41',       '{"size":"41"}'::jsonb,       NULL,   TRUE),
  ('eeeeeeee-eeee-eeee-eeee-0000000ff502', 'eeeeeeee-eeee-eeee-eeee-0000000bb005', 'COURT-42',       '{"size":"42"}'::jsonb,       NULL,   TRUE),
  ('eeeeeeee-eeee-eeee-eeee-0000000ff503', 'eeeeeeee-eeee-eeee-eeee-0000000bb005', 'COURT-43',       '{"size":"43"}'::jsonb,       NULL,   TRUE),
  ('eeeeeeee-eeee-eeee-eeee-0000000ff601', 'eeeeeeee-eeee-eeee-eeee-0000000bb006', 'ANDROMEDA-32',   '{"size":"32\""}'::jsonb,     195000, TRUE),
  ('eeeeeeee-eeee-eeee-eeee-0000000ff602', 'eeeeeeee-eeee-eeee-eeee-0000000bb006', 'ANDROMEDA-43',   '{"size":"43\""}'::jsonb,     NULL,   TRUE),
  ('eeeeeeee-eeee-eeee-eeee-0000000ff603', 'eeeeeeee-eeee-eeee-eeee-0000000bb006', 'ANDROMEDA-55',   '{"size":"55\""}'::jsonb,     345000, TRUE),
  ('eeeeeeee-eeee-eeee-eeee-0000000ff701', 'eeeeeeee-eeee-eeee-eeee-0000000bb007', 'MAKOLA-FAMILY',  '{"bundle":"Family"}'::jsonb, NULL,   TRUE),
  ('eeeeeeee-eeee-eeee-eeee-0000000ff702', 'eeeeeeee-eeee-eeee-eeee-0000000bb007', 'MAKOLA-BULK',    '{"bundle":"Bulk"}'::jsonb,   68000,  TRUE),
  ('eeeeeeee-eeee-eeee-eeee-0000000ff801', 'eeeeeeee-eeee-eeee-eeee-0000000bb008', 'STEPS-GREY',     '{"colour":"Grey"}'::jsonb,   NULL,   TRUE),
  ('eeeeeeee-eeee-eeee-eeee-0000000ff802', 'eeeeeeee-eeee-eeee-eeee-0000000bb008', 'STEPS-NAVY',     '{"colour":"Navy"}'::jsonb,   NULL,   TRUE)
ON CONFLICT (id) DO NOTHING;

INSERT INTO inventory (variant_id, quantity_available, quantity_reserved, restock_threshold)
SELECT id, 25, 0, 5 FROM product_variants
 WHERE id::text LIKE 'eeeeeeee-eeee-eeee-eeee-0000000ff%'
ON CONFLICT (variant_id) DO NOTHING;

-- ------------------------------------------------------------- plan offers
-- Everything over GHS 100 can be split; the fortnightly plan is offered on the
-- big-ticket items only, which is what its GHS 500 floor already implies.
INSERT INTO product_plan_offers (product_id, plan_template_id, is_active)
SELECT p.id, 'eeeeeeee-eeee-eeee-eeee-000000000001', TRUE
  FROM products p
 WHERE p.id::text LIKE 'eeeeeeee-eeee-eeee-eeee-0000000bb%'
   AND p.base_price_pesewas >= 10000
ON CONFLICT DO NOTHING;

INSERT INTO product_plan_offers (product_id, plan_template_id, is_active)
SELECT p.id, 'eeeeeeee-eeee-eeee-eeee-000000000002', TRUE
  FROM products p
 WHERE p.id::text LIKE 'eeeeeeee-eeee-eeee-eeee-0000000bb%'
   AND p.base_price_pesewas >= 50000
ON CONFLICT DO NOTHING;

-- ------------------------------------------------------------- pickup hubs
INSERT INTO pickup_hubs (id, name, region, city, area, detail, position, is_active) VALUES
  ('eeeeeeee-eeee-eeee-eeee-0000000ee001', 'Circle MoMo Hub',    'Greater Accra', 'Accra',  'Circle',  'Kwame Nkrumah Ave · open till 8pm', 1, TRUE),
  ('eeeeeeee-eeee-eeee-eeee-0000000ee002', 'Osu Oxford Point',   'Greater Accra', 'Accra',  'Osu',     'Oxford St · open till 9pm',         2, TRUE),
  ('eeeeeeee-eeee-eeee-eeee-0000000ee003', 'Madina Market Desk', 'Greater Accra', 'Accra',  'Madina',  'Zongo Junction · open till 7pm',    3, TRUE),
  ('eeeeeeee-eeee-eeee-eeee-0000000ee004', 'Kejetia Collect',    'Ashanti',       'Kumasi', 'Kejetia', 'Kejetia Market, gate 4 · till 6pm', 4, TRUE)
ON CONFLICT (id) DO NOTHING;
