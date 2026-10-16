-- ============================================================================
-- 0024_application_plan_terms.sql  (The terms a customer applied under)
-- ============================================================================
-- An application stored `plan_template_id` and the amount, and nothing about
-- the terms. Activation read them from the template, live. But a live
-- template's money terms are editable — `updatePlanTemplateSchema` allows
-- interest_rate_bps, service_fee_flat_pesewas, grace_period_days and both
-- late-fee fields — so an application that sat in manual review while staff
-- repriced the template was activated at the new price, not the one the
-- customer was quoted and agreed to.
--
-- `customer_plans` already freezes its terms at activation ("the plan is the
-- contract"). This moves the freeze one step earlier, to the moment the
-- customer commits: submit copies the template's terms here, and activation
-- reads them from here and not from the template.
--
-- One JSONB column, for the reason 0022 gives for `delivery_address`: written
-- once, read whole, never filtered or joined on its parts. The shape is
-- validated in code (`planTermsSchema`) on the way in and on the way out.
--
-- Existing rows are backfilled from their template as it stands today. For an
-- application already activated that is informational — its plan carries its
-- own terms. For one still in flight it is the best record that exists; it may
-- differ from what that customer was quoted if the template was edited since,
-- and nothing kept the earlier values to restore.
-- ============================================================================

BEGIN;

ALTER TABLE applications ADD COLUMN plan_terms JSONB;

UPDATE applications a SET plan_terms = jsonb_build_object(
  'business_model',             t.business_model,
  'number_of_installments',     t.number_of_installments,
  'installment_frequency_days', t.installment_frequency_days,
  'down_payment_bps',           t.down_payment_bps,
  'interest_rate_bps',          t.interest_rate_bps,
  'service_fee_flat_pesewas',   t.service_fee_flat_pesewas,
  'grace_period_days',          t.grace_period_days,
  'late_fee_bps_per_week',      t.late_fee_bps_per_week,
  'late_fee_cap_bps',           t.late_fee_cap_bps
)
FROM plan_templates t
WHERE t.id = a.plan_template_id;

ALTER TABLE applications ALTER COLUMN plan_terms SET NOT NULL;

COMMENT ON COLUMN applications.plan_terms IS
  'The plan terms the customer applied under, copied from the template at submit. Activation reads these, not the template.';

COMMIT;
