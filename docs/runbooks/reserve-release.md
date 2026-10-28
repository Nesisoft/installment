# Runbook — seller reserves that have not been released

**Alert:** `reserve releases could not be booked` (error), from the reserve sweep
(`ReserveReleaseCron`, daily at 07:00 server time). It lists each failure: the `held_reserves`
id, the plan and the error.
**Also comes in as:** a seller asking where their reserve is.
**Severity:** medium — a seller is owed money later than they should be. Nothing is lost while it
waits.
**Console:** Merchants → the merchant → **Open reserves**. Each row shows the model, what was
held, what is still outstanding and the date it can be released from — a dash when the event it
waits on has not happened yet.

---

## What a reserve is, and when it comes back

When a plan pays a seller, part of the payout is withheld as a reserve against that plan going
wrong — a default, a refund. It is booked to `reserve_held[plan]` and tracked by a
`held_reserves` row. How much is withheld, and what releases it, depends on the plan's model:

| Model       | Reserve | Released                                                        |
| ----------- | ------- | --------------------------------------------------------------- |
| BNPL        | 5%      | 14 days after the plan completes                                |
| Layaway     | 2%      | 7 days after delivery                                           |
| Hybrid      | 7%      | 14 days after the plan completes                                |
| Rent-to-own | 12%     | One twelfth every 30 days from when it was held, over 12 months |

These are the defaults in `MODEL_CONFIG`; a merchant can have a negotiated reserve rate, shown on
their page as "Reserve on a plan".

If the plan **defaults**, the reserve covers the loss first (`DefaultService`). On the buffer
models, whatever is left is released on the same buffer, counted from the default.

Every day at 07:00 the sweep walks each merchant with an open reserve and releases what has
matured: debit `reserve_held[plan]`, credit `merchant_payable[merchant]`. Released reserve is paid
on the next day's settlement run. A release never takes more than the ledger still holds for the
plan, so a refund that already drew on the reserve is not paid out twice.

A **re-collected refund** reopens a completed plan; its reserve clock stops and restarts at the
next completion, because the plan carries risk again.

---

## 1. "Reserve releases could not be booked"

One or more rows threw while being released. The sweep carried on past them, and each failed row
is retried by tomorrow's sweep. The alert lists every failure with its `held_reserves` id, its
plan and the error; a failure with no id means the sweep could not read that merchant's
reserves at all (a lock timeout, a dropped connection), which usually clears on the next run.

1. Read the errors. If the same rows fail on consecutive days, it is a defect: raise it with
   engineering with the ids and errors.
2. Do not release by hand. A release is a ledger posting, and the ledger is append-only; there is
   deliberately no route that releases a reserve on request.

## 2. A seller asks where their reserve is

Open the merchant's **Open reserves** card.

- **A date in the past** — it has matured and the next 07:00 sweep releases it; the next day's
  payout pays it. If the date is more than a day old and the row is still open, look for the
  alert in §1.
- **A date in the future** — it is waiting its buffer out. Tell the seller the date.
- **A dash** — the event it waits on has not happened:
  - **BNPL or hybrid:** the plan has not completed. The customer is still paying.
  - **Layaway:** the delivery has not been recorded. See §3.
- **Rent-to-own** rows show the date they started releasing; they pay out a twelfth a month.

## 3. A delivered order whose layaway reserve is still waiting

Marking an order delivered (seller app, merchant web) also tells the engine the plan was
delivered, which starts the 7-day buffer. That second step runs after the order is saved, so if
it fails the order shows delivered and the reserve keeps waiting.

Record the delivery against the plan directly:

```
POST /admin/plans/:planId/delivery          (needs plans:deliver)
```

It is idempotent — a plan already marked delivered is left as it is — and stamps the reserve rows
so the next sweep counts the buffer from the delivery date.

---

## What not to do

- **Do not pay a reserve to a seller by hand.** The reserve is still on the books as owed to the
  plan; paying it outside the system pays it twice when the sweep releases it.
- **Do not edit `held_reserves` rows to make one release.** The ledger is the record. Corrections
  go through the money-repairs tool ([`money-repairs.md`](./money-repairs.md)).
