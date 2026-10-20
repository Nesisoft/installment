# Runbook — repairing what four fixed money bugs left behind

**When:** once, after #106, #110, #111 and #114 are deployed to production. Safe to re-run:
a finding that has been corrected drops off the report, and correcting it again does nothing.
**Tool:** `pnpm repair:money` (`apps/api/src/tools/money-repairs.ts`).
**Severity:** each finding is money already wrong for a real merchant or customer.

---

## What happened

Each fix stopped _new_ damage. None of them repaired what was already in the database:

| Fix  | What it left behind                                                                                                                   | Repair                                         |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| #114 | Defaults sized on the customer's whole unpaid balance, not on what had been fronted. Hybrid sellers clawed for money never paid them. | compensating ledger entries                    |
| #111 | Settled payouts Paystack reversed, still recorded as paid.                                                                            | apply the reversal through the fixed code path |
| #110 | Collections cases closed as "Restructured", or "Paid" with nothing paid. The instalment was neither collected nor written off.        | a person decides, case by case                 |
| #106 | Payment attempts Paystack never heard of, left `unknown`.                                                                             | none — the verify poll now settles them        |

`ledger_entries` is append-only (see [ledger-imbalance.md](ledger-imbalance.md)). Nothing here edits
an entry: a wrong posting is answered by a compensating one, and both stay in the book.

---

## 1. Report — reads only

```bash
DATABASE_URL=<production, a read replica is fine> pnpm repair:money
DATABASE_URL=... pnpm repair:money -- --json   # the same, as JSON
```

Or run the queries yourself — `pnpm repair:money -- sql` prints them, and they are copied in
section 6. Each is a plain `SELECT` with nothing to fill in.

Keep the report output. It is the record of what was wrong before anything was changed.

## 2. Oversized defaults (#114)

A default's loss was the customer's whole unpaid balance: the reserve first, then the merchant's
payable (hybrid, rent to own) or Ejua's default pool (BNPL). It should have been what Ejua had
fronted and not had back — the receivable still open on the plan. They differ wherever the balance
held something nobody fronted:

- **Hybrid** credits 40% at the deposit and 60% at completion. A customer who paid the deposit and
  stopped left the merchant at −21,600 on a 100,000 order they had been paid 35,600 for; one who
  never paid the deposit, at −100,000.
- **Interest** on any model. On rent to own the merchant was clawed for interest Ejua never fronted;
  on BNPL the pool was.

The report shows, per plan, what was written off, what should have been, and what each account gets
back. To correct:

```bash
REPAIR_OPERATOR_EMAIL=<your admin email> pnpm repair:money -- apply-defaults          # lists, writes nothing
REPAIR_OPERATOR_EMAIL=<your admin email> pnpm repair:money -- apply-defaults --yes    # corrects every one
REPAIR_OPERATOR_EMAIL=<your admin email> pnpm repair:money -- apply-defaults --plan <id> --yes
```

Each correction is one balanced transaction, `compensate:default:<plan>`, posted through
`LedgerService` (which refuses an unbalanced one):

- `receivable` **debit** — the excess written off;
- `reserve_held` **credit** — reserve drawn beyond the real loss;
- `merchant_payable` **credit** — claw-back beyond the real loss (hybrid, rent to own);
- `default_pool` **credit** — pool charge beyond the real loss (BNPL).

The restored reserve goes back on its `held_reserves` row with the default's release clock, so the
nightly sweep pays it to the merchant on the model's usual buffer. Cash a customer paid after the
default — held as float, because the oversized write-off left nothing owed — is swept onto the
reopened receivable. The merchant's restored payable goes out on the next settlement run. An audit
event `customer_plan.default_corrected` records the figures and the operator, and the plan's
settlement view (admin console, merchant portal) shows the corrected default.

**A refused plan** wrote nothing and does not stop the others; the run lists it and exits non-zero.
It means the old booking does not look like the old code's — most likely a default from before the
reserve was drawn first, where a correction would have to take more, not give back. Look at its
`default:<plan>` transaction (section 1 of [ledger-imbalance.md](ledger-imbalance.md)) and decide by
hand; skip it with `--plan` on the others meanwhile.

**Tell the merchant** (hybrid and rent to own only — a BNPL correction moves Ejua's own pool and no
merchant money): the amount returned, that it is in their next payout, and that it was our error.

## 3. Ignored payout reversals (#111)

Paystack reverses a transfer days after it succeeded when the receiving bank or wallet rejects it.
The `transfer.reversed` webhook was stored and marked processed, and nothing moved: the payout still
reads settled and the merchant is recorded as paid while holding nothing.

```bash
REPAIR_OPERATOR_EMAIL=<your admin email> pnpm repair:money -- apply-reversals [--reference <ref>] [--yes]
```

This calls `SettlementService.confirmPayout(reference, 'reversed')` — the path the webhook now takes:
the payout becomes `reversed`, `payout-reversal:<reference>` gives the amount back to the merchant's
payable, and the next run pays it. An audit event `payout.reversal_applied` records the operator.

**Before the next run**, check the merchant's payout account. The bank or wallet that sent the money
back will most likely send it back again. Ask the merchant to confirm or change it (merchant web,
_Payout account_).

## 4. Stranded collections cases (#110)

A case closed as "Restructured" (no restructuring exists) or as "Paid" without a payment left its
instalment `in_collections` with no open case. Nothing looks at it again: it is not collected, not
waived, not written off. The report lists each one with the customer, what is unpaid, and the note
left when it was closed. Decide each one:

| What actually happened                     | Do this                                                                                             |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| The customer paid (cash at a branch, etc.) | Record the payment on the plan in the admin console. The instalment leaves `in_collections`; done.  |
| The debt was meant to be forgiven          | Reopen the case (below), then close it as **Waived** in the admin console. That records the waiver. |
| Nobody decided anything                    | Reopen the case. Collections starts again from the first reminder.                                  |

```bash
REPAIR_OPERATOR_EMAIL=<your admin email> REPAIR_REASON='<why, in a sentence>' \
  pnpm repair:money -- reopen-case <case-id> [--yes]
```

A reopened case starts the ladder again: `soft_reminder`, opened today. Escalation counts a case's age
from `opened_at`, so reopening one with its original date would send a case opened ninety days ago
straight to write-off on the next nightly sweep — defaulting the whole plan before anyone could waive
it. The customer heard nothing while it was closed, and starting the reminders from the first is the
fair course anyway. The original date and stage are kept in the `collections_case.reopened` audit
event, with the reason.

Cases on a plan that has defaulted since are not listed: the debt was written off with the plan.

## 5. Unresolved payment attempts (#106)

Nothing to do. The verify poll picks up every in-flight or `unknown` attempt older than fifteen
minutes, whatever its age, and since #106 it settles one Paystack has no record of as failed. The
report shows how many are left; the number should fall to zero within the hour after deploy. If it
does not, check that `ENABLE_SCHEDULED_WORKERS` is on and look for `verify-poll` errors.

## 6. The queries

Copies of `packages/core/src/modules/repairs/queries.ts`; a unit test fails if they drift.

### oversized_defaults

```sql
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
```

### ignored_payout_reversals

```sql
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
```

### stranded_collections_cases

```sql
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
```

### unresolved_payment_attempts

```sql
SELECT status, count(*) AS attempts, min(initiated_at) AS oldest
FROM payment_attempts
WHERE status IN ('in_flight', 'unknown')
  AND initiated_at < now() - interval '1 hour'
GROUP BY status
ORDER BY status
```

## 7. Afterwards

- Re-run the report: every section should be empty, or hold only cases you have chosen to leave.
- `GET /admin/ledger/integrity` must still report `healthy: true`.
- Record what was corrected — the report from step 1 and the tool's output — with who authorised it.
