-- ============================================================================
-- 0007_charge_integrity.sql  (Slice S1 — one installment, one charge)
-- ============================================================================
-- Closes the database half of the double-charge defect.
--
-- `activateFromApplication` guards against activating one application twice
-- with a bare check-then-insert:
--
--     SELECT id FROM customer_plans WHERE application_id = $1 LIMIT 1
--     ...
--     INSERT INTO customer_plans (...)
--
-- Under READ COMMITTED (the default) two concurrent activations both see zero
-- rows and both insert — a textbook phantom write. The result is two active
-- plans for one order: two full installment schedules debiting the customer,
-- and two `accrue:{planId}:order_approved` ledger transactions paying the
-- merchant twice. The transaction ids differ (they embed the plan id), so
-- PayoutRecorder's idempotency cannot collapse them, and the ledger stays
-- balanced while being wrong — nothing downstream can detect it.
--
-- The column had no index of any kind, so this also removes a sequential scan
-- from the activation path.
--
-- NOTE: this will fail if duplicates already exist. That is deliberate — a
-- duplicate here means a customer has been double-scheduled and the rows must
-- be reconciled by hand before the constraint can be trusted. To find them:
--
--   SELECT application_id, count(*), array_agg(id)
--   FROM customer_plans GROUP BY application_id HAVING count(*) > 1;
-- ============================================================================

BEGIN;

CREATE UNIQUE INDEX customer_plans_application_uq ON customer_plans (application_id);

COMMIT;
