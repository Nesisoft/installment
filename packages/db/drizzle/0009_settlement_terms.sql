-- ============================================================================
-- 0009_settlement_terms.sql  (Slice S8 — pay the right merchant the right amount)
-- ============================================================================
-- Two changes supporting correct, separately-authorised merchant settlement.
--
-- 1) A dedicated settlements:run permission.
--
--    All three settlement routes — run the daily batch, settle one merchant,
--    reconcile payouts — were gated behind `plans:write`, whose seeded
--    description is "Create / update plan templates". Anyone trusted to edit a
--    plan template could therefore also fire a real payout batch. Moving money
--    to merchants deserves its own grant.
--
--    Seeded to `admin` only. Assign it to an operations role deliberately, not
--    by inheriting it from an unrelated capability.
--
-- 2) merchants.min_payout_pesewas.
--
--    Settlement fires a Paystack transfer for any positive balance, so a
--    GHS 0.50 residue triggers a real transfer whose fee can exceed the payout
--    itself. This is the per-merchant floor; a balance below it rolls forward
--    to the next run rather than being paid out. Defaults to GHS 100 (10,000
--    pesewas), the figure in docs/design/settlement-engine.ts.
--
--    Zero is allowed and means "always pay out", which is the right setting for
--    a merchant who has asked for it.
-- ============================================================================

BEGIN;

-- 1) settlements:run -----------------------------------------------------------
INSERT INTO permissions (name, description) VALUES
  ('settlements:run', 'Trigger settlement runs and payout reconciliation')
ON CONFLICT (name) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id
  FROM roles r CROSS JOIN permissions p
  WHERE r.name = 'admin' AND p.name = 'settlements:run'
ON CONFLICT DO NOTHING;

-- 2) Minimum payout ------------------------------------------------------------
ALTER TABLE merchants
  ADD COLUMN min_payout_pesewas BIGINT NOT NULL DEFAULT 10000
    CHECK (min_payout_pesewas >= 0);

-- 3) Explicit rate overrides ---------------------------------------------------
--
--    `customer_plans.mdr_bps` / `reserve_bps` are snapshotted at activation and
--    were read by nothing, so every accrual silently used MODEL_CONFIG. The fix
--    is to honour the snapshot — but the snapshot was being copied from
--    `merchants.default_mdr_bps` / `default_reserve_bps`, which are NOT NULL
--    with defaults 400/500. Those defaults are model-agnostic, so honouring
--    them directly would re-price every layaway plan from the model's
--    risk-based 2% reserve / 3% MDR up to 5% / 4% — for merchants who never
--    negotiated anything. The schema cannot tell "deliberately set to 500" from
--    "nobody touched it".
--
--    These nullable columns make the intent explicit. NULL means "use the rate
--    for this business model"; a value means a genuinely negotiated rate. The
--    older `default_*` columns stay for display and are no longer authoritative.
ALTER TABLE merchants
  ADD COLUMN mdr_bps_override INTEGER
    CHECK (mdr_bps_override IS NULL OR (mdr_bps_override >= 0 AND mdr_bps_override <= 2000)),
  ADD COLUMN reserve_bps_override INTEGER
    CHECK (reserve_bps_override IS NULL OR (reserve_bps_override >= 0 AND reserve_bps_override <= 5000));

COMMENT ON COLUMN merchants.mdr_bps_override IS
  'Negotiated MDR in bps. NULL = use the business model default.';
COMMENT ON COLUMN merchants.reserve_bps_override IS
  'Negotiated reserve in bps. NULL = use the business model default.';

-- 4) Align existing snapshots with what was actually applied -------------------
--
--    Until now every accrual used MODEL_CONFIG regardless of what was stored on
--    the plan, so the stored values describe a rate that was never charged.
--    Rewriting them to the model rates makes the snapshot match the money that
--    actually moved — the ledger is append-only, so the alternative would be
--    future accruals on an existing plan silently using a different rate from
--    the ones already booked against it.
UPDATE customer_plans SET
  mdr_bps = CASE business_model
    WHEN 'bnpl' THEN 400 WHEN 'layaway' THEN 300
    WHEN 'hybrid' THEN 400 WHEN 'rent_to_own' THEN 500 ELSE mdr_bps END,
  reserve_bps = CASE business_model
    WHEN 'bnpl' THEN 500 WHEN 'layaway' THEN 200
    WHEN 'hybrid' THEN 700 WHEN 'rent_to_own' THEN 1200 ELSE reserve_bps END;

COMMIT;
