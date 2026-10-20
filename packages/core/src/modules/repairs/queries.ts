/**
 * Read-only queries that find what four fixed bugs left wrong in the data.
 *
 * Each fix stopped new damage and repaired nothing already done: a default
 * already booked keeps its old size, a reversal already ignored stays ignored, a
 * case already closed stays closed. These find the rows, with the amounts.
 *
 * They are the single source: `MoneyRepairsService` runs them, `pnpm
 * repair:money sql` prints them for psql, and `docs/runbooks/money-repairs.md`
 * carries copies a test keeps in step. Every one is a plain SELECT with no
 * parameters, so an operator can run it against production with nothing to
 * fill in and nothing to undo.
 */

/**
 * Defaults booked larger than what the platform had fronted (#114).
 *
 * A default's loss was the customer's whole unpaid balance. The fixed sizing is
 * the receivable still open on the plan at that moment — what was credited to
 * the merchant and not yet repaid. The two differ wherever the balance holds
 * something nobody fronted: hybrid's 60% completion slice, interest on any
 * model. The excess was taken from the plan's reserve and then from the
 * merchant's payable (hybrid, rent_to_own) or Ejua's default pool (bnpl).
 *
 * "At that moment" is every receivable and reserve entry on the plan up to the
 * default's own timestamp, excluding the default itself. A
 * `compensate:default` already posted takes the plan off the list.
 */
export const OVERSIZED_DEFAULTS_SQL = `
WITH d AS (
  SELECT le.transaction_id,
         substr(le.transaction_id, length('default:') + 1) AS plan_ref,
         min(le.occurred_at) AS defaulted_at,
         coalesce(sum(le.amount_pesewas) FILTER (WHERE le.account_type = 'receivable' AND le.direction = 'credit'), 0) AS written_off,
         coalesce(sum(le.amount_pesewas) FILTER (WHERE le.account_type = 'reserve_held' AND le.direction = 'debit'), 0) AS from_reserve,
         coalesce(sum(le.amount_pesewas) FILTER (WHERE le.account_type = 'merchant_payable' AND le.direction = 'debit'), 0) AS from_merchant,
         coalesce(sum(le.amount_pesewas) FILTER (WHERE le.account_type = 'default_pool' AND le.direction = 'debit'), 0) AS from_pool
  FROM ledger_entries le
  WHERE le.transaction_id LIKE 'default:%'
  GROUP BY le.transaction_id
),
before_default AS (
  SELECT d.*,
         coalesce((SELECT sum(CASE x.direction WHEN 'debit' THEN x.amount_pesewas ELSE -x.amount_pesewas END)
                   FROM ledger_entries x
                   WHERE x.account_type = 'receivable' AND x.account_ref = d.plan_ref
                     AND x.transaction_id <> d.transaction_id AND x.occurred_at <= d.defaulted_at), 0) AS fronted_open,
         coalesce((SELECT sum(CASE x.direction WHEN 'credit' THEN x.amount_pesewas ELSE -x.amount_pesewas END)
                   FROM ledger_entries x
                   WHERE x.account_type = 'reserve_held' AND x.account_ref = d.plan_ref
                     AND x.transaction_id <> d.transaction_id AND x.occurred_at <= d.defaulted_at), 0) AS reserve_before
  FROM d
),
sized AS (
  SELECT b.*, least(b.written_off, greatest(0, b.fronted_open)) AS should_write_off
  FROM before_default b
),
split AS (
  SELECT s.*, least(greatest(0, s.reserve_before), s.should_write_off) AS should_from_reserve
  FROM sized s
)
SELECT cp.id AS customer_plan_id,
       cp.merchant_id,
       cp.business_model,
       s.defaulted_at,
       s.fronted_open,
       s.written_off,
       s.should_write_off,
       s.from_reserve,
       s.should_from_reserve,
       s.from_merchant,
       CASE WHEN cp.business_model = 'bnpl' THEN 0 ELSE s.should_write_off - s.should_from_reserve END AS should_from_merchant,
       s.from_pool,
       CASE WHEN cp.business_model = 'bnpl' THEN s.should_write_off - s.should_from_reserve ELSE 0 END AS should_from_pool
FROM split s
JOIN customer_plans cp ON cp.id::text = s.plan_ref
WHERE s.written_off > s.should_write_off
  AND NOT EXISTS (
    SELECT 1 FROM ledger_entries c WHERE c.transaction_id = 'compensate:default:' || s.plan_ref
  )
ORDER BY s.defaulted_at
`.trim();

/**
 * Settled payouts Paystack reversed, where the reversal was ignored (#111).
 *
 * `transfer.reversed` was mapped to a failure, and a failure reported for a
 * settled payout is a no-op — so the event was stored, marked processed, and
 * nothing moved. The payout still reads settled and the merchant's payable
 * still reads paid.
 */
export const IGNORED_PAYOUT_REVERSALS_SQL = `
SELECT DISTINCT ON (p.id)
       p.id AS payout_id,
       p.reference,
       p.merchant_id,
       p.amount_pesewas,
       p.settled_at,
       w.received_at AS reversed_at,
       w.payload -> 'data' ->> 'gateway_response' AS gateway_response
FROM webhook_events w
JOIN payouts p ON p.reference = w.payload -> 'data' ->> 'reference'
WHERE w.event_type = 'transfer.reversed'
  AND p.status = 'settled'
ORDER BY p.id, w.received_at
`.trim();

/**
 * Collections cases closed over an instalment nobody settled (#110).
 *
 * Closing as "restructured", or as "paid" without a payment, left the
 * instalment `in_collections` with no open case: escalation reads open cases,
 * case-opening reads `overdue` rows, the default path reads open cases. The
 * debt was neither collected, waived nor written off. Which of those it should
 * be is a person's call, so this lists them with what was said at the time.
 *
 * A plan that has defaulted since wrote the debt off at plan level, so its
 * cases are not stranded; reopening one would restart dunning on a written-off
 * plan.
 */
export const STRANDED_COLLECTIONS_CASES_SQL = `
SELECT DISTINCT ON (c.schedule_id)
       c.id AS case_id,
       c.customer_plan_id,
       c.schedule_id,
       c.resolution,
       c.closed_at,
       s.sequence_number,
       s.due_date,
       s.amount_due_pesewas,
       s.amount_paid_pesewas,
       s.late_fee_pesewas,
       cu.first_name || ' ' || cu.last_name AS customer_name,
       cu.phone AS customer_phone,
       closed.actor_id AS closed_by,
       closed.reason AS close_note
FROM collections_cases c
JOIN installment_schedule s ON s.id = c.schedule_id
JOIN customer_plans cp ON cp.id = c.customer_plan_id
JOIN customers cu ON cu.id = cp.customer_id
LEFT JOIN LATERAL (
  SELECT a.actor_id, a.reason
  FROM audit_events a
  WHERE a.entity_type = 'collections_case' AND a.entity_id = c.id
    AND a.event_type = 'collections_case.closed'
  ORDER BY a.occurred_at DESC
  LIMIT 1
) closed ON true
WHERE c.closed_at IS NOT NULL
  AND s.status = 'in_collections'
  AND cp.status <> 'defaulted'
  AND NOT EXISTS (
    SELECT 1 FROM collections_cases o WHERE o.schedule_id = c.schedule_id AND o.closed_at IS NULL
  )
ORDER BY c.schedule_id, c.closed_at DESC
`.trim();

/**
 * Payment attempts still unresolved an hour after they started (#106).
 *
 * Needs no repair: the verify poll picks up every in-flight or unknown attempt
 * older than fifteen minutes, whatever its age, and since #106 it settles one
 * Paystack has no record of as failed. This is how to watch them drain.
 */
export const UNRESOLVED_ATTEMPTS_SQL = `
SELECT status, count(*) AS attempts, min(initiated_at) AS oldest
FROM payment_attempts
WHERE status IN ('in_flight', 'unknown')
  AND initiated_at < now() - interval '1 hour'
GROUP BY status
ORDER BY status
`.trim();

export const REPAIR_QUERIES = {
  oversized_defaults: OVERSIZED_DEFAULTS_SQL,
  ignored_payout_reversals: IGNORED_PAYOUT_REVERSALS_SQL,
  stranded_collections_cases: STRANDED_COLLECTIONS_CASES_SQL,
  unresolved_payment_attempts: UNRESOLVED_ATTEMPTS_SQL,
} as const;
