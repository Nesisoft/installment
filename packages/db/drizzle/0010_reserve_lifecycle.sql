-- ============================================================================
-- 0010_reserve_lifecycle.sql  (Slice S6 — reserves come back out)
-- ============================================================================
-- The merchant reserve is the platform's security against a plan going bad:
-- 2-12% of every order, withheld at accrual and released once the model's
-- policy says the risk has passed. Two of the three release policies had no
-- way to ever fire, so for those plans the reserve was not withheld — it was
-- confiscated.
--
-- 1) held_reserves.plan_defaulted_at
--
--    `after_plan_completion` (bnpl, hybrid) waits on `plan_completed_at`, and
--    `after_delivery` (layaway) waits on `delivered_at`. A plan that defaults
--    will never complete and will never deliver, so neither trigger can ever
--    fire — and whatever reserve survives the default's loss allocation stays
--    withheld for the life of the database.
--
--    Default is the terminal event for such a plan. Stamping it starts the same
--    buffer clock completion would have, so the surviving remainder matures and
--    goes back to the merchant.
--
-- 2) plans:deliver
--
--    Recording delivery is what releases a layaway merchant's reserve, so it
--    moves money and deserves its own grant rather than riding on `plans:write`
--    ("Create / update plan templates") or `applications:review`.
--
--    Seeded to `admin` only. Assign it to a fulfilment/ops role deliberately.
-- ============================================================================

BEGIN;

-- 1) The default release trigger ------------------------------------------------
ALTER TABLE held_reserves
  ADD COLUMN plan_defaulted_at TIMESTAMPTZ;

COMMENT ON COLUMN held_reserves.plan_defaulted_at IS
  'Set when the plan defaulted. Starts the release buffer for whatever reserve survives the loss allocation, since a defaulted plan can never complete or deliver.';

-- 2) plans:deliver ---------------------------------------------------------------
INSERT INTO permissions (name, description) VALUES
  ('plans:deliver', 'Record product delivery against a customer plan')
ON CONFLICT (name) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id
  FROM roles r CROSS JOIN permissions p
  WHERE r.name = 'admin' AND p.name = 'plans:deliver'
ON CONFLICT DO NOTHING;

COMMIT;
