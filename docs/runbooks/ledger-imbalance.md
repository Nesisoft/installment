# Runbook — ledger integrity failure

**Alert:** `ledger integrity check failed`
**Source:** `LedgerIntegrityCron` (hourly)
**Severity:** high — the financial record disagrees with itself.

---

## What the alert means

Every ledger transaction posts equal debits and credits, so summing every
account balance must give exactly `0`. This alert fires when that total is
non-zero, or when a specific transaction's debits and credits disagree.

Two things follow immediately, and both shape the response:

1. **`ledger_entries` is append-only.** A `BEFORE UPDATE OR DELETE` trigger
   blocks edits and deletes. You **cannot** fix a bad row. The only remedy is a
   _compensating entry_ that offsets it, and both the error and the compensation
   remain visible in the book forever. That is by design — an auditor must be
   able to see what happened.
2. **Do not attempt a "quick fix" in SQL.** Disabling the trigger to correct a
   row destroys the property that makes the ledger evidence. If you believe that
   is genuinely necessary, it is an incident-commander decision, not an
   operator one.

---

## 1. Confirm and locate

```
GET /admin/ledger/integrity      # requires audit:read
```

Returns the trial balance and up to 100 offending transactions.

Or directly:

```sql
-- Which transactions are unbalanced?
SELECT transaction_id,
       sum(CASE WHEN direction = 'debit'  THEN amount_pesewas ELSE 0 END) AS debits,
       sum(CASE WHEN direction = 'credit' THEN amount_pesewas ELSE 0 END) AS credits
FROM ledger_entries
GROUP BY transaction_id
HAVING sum(CASE WHEN direction = 'debit'  THEN amount_pesewas ELSE 0 END)
    <> sum(CASE WHEN direction = 'credit' THEN amount_pesewas ELSE 0 END);
```

```sql
-- The full picture of one transaction
SELECT account_type, account_ref, direction, amount_pesewas, description, occurred_at
FROM ledger_entries
WHERE transaction_id = '<id>'
ORDER BY occurred_at;
```

The `transaction_id` prefix tells you which code path wrote it:

| Prefix             | Written by              | Meaning                                |
| ------------------ | ----------------------- | -------------------------------------- |
| `accrue:`          | `PayoutRecorder`        | merchant accrual on a payout trigger   |
| `collect:`         | `PlanCashLedger`        | customer paid an installment           |
| `float-sweep:`     | `PlanCashLedger`        | held cash applied to a new accrual     |
| `finance-income:`  | `PlanCashLedger`        | interest/fees recognised at completion |
| `refund-cash:`     | `PlanCashLedger`        | cash leg of a refund                   |
| `refund:`          | `PayoutRecorder`        | accrual clawback on a refund           |
| `payout:`          | `SettlementService`     | merchant payout booked                 |
| `payout-reversal:` | `SettlementService`     | failed transfer reversed               |
| `release:`         | `ReserveReleaseService` | reserve matured to the merchant        |
| `default:`         | `DefaultService`        | loss allocated on a defaulted plan     |

## 2. Establish blast radius

```sql
-- Is it one transaction or a pattern? Group by prefix.
SELECT split_part(transaction_id, ':', 1) AS kind, count(*)
FROM ledger_entries
WHERE transaction_id IN (<offending ids>)
GROUP BY 1;
```

A single transaction is usually a one-off (an interrupted process, a manual
insert). **A pattern by prefix means a code path is writing bad postings and is
still doing so** — that is the urgent case. Stop the responsible worker
(`ENABLE_SCHEDULED_WORKERS=false` on the affected instance) before compensating,
or you will be chasing a moving target.

## 3. Decide the true position

Work out what the transaction _should_ have posted, from the source records —
`payment_attempts`, `payouts`, `customer_plans`, `installment_schedule` — not
from the ledger itself. The ledger is what is in doubt.

For a `collect:` transaction, `payment_attempts.amount_pesewas` and the
provider's own record are authoritative for how much money actually moved.

## 4. Compensate

Write a **new** balanced transaction that moves the affected accounts to their
correct positions. Use a `transaction_id` that states what it is and references
the original:

```
compensate:<original-transaction-id>
```

Post it through `LedgerService.record` (which validates the balance) rather than
raw SQL, so it cannot itself be unbalanced. Every compensation needs a
`description` naming the incident.

## 5. Verify and record

- Re-run `GET /admin/ledger/integrity` — `healthy` must be `true`.
- Confirm the trial balance total is `0`.
- Record the incident: what drifted, by how much, which code path, the
  compensating `transaction_id`, and who authorised it. An auditor will ask.

---

## Prevention already in place

- `ledger_posting_identity_uq` (migration 0008) — unique on
  `(transaction_id, account_type, account_ref, direction)`. Stops a concurrent
  double-post, which would otherwise still _balance_ (2 debits + 2 credits) and
  therefore be invisible to the checks above.
- `LedgerService.record` rejects unbalanced input, zero and negative amounts,
  mixed transaction ids, and unknown account types.
- Append-only triggers on `ledger_entries` and `audit_events`.

## Known non-issues

The integration test suite shares one database, and
`transaction.integration.spec.ts` deliberately writes a half-transaction to
prove rollback semantics. A local or CI database may therefore show one
unbalanced `txn-int-*` transaction. **This is expected in test databases only.**
In production it is real.
