# Runbook — refunds that have not reached the customer

**Alerts:**

- `refunds could not be sent`, `refunds could not be reconciled` (from `RefundCron`, every 5 minutes);
- a webhook alert naming a refund that Paystack reports processed after it was refused or paid by hand (see §5).

**Severity:** high — a customer is waiting for money we owe them, or may have been paid twice.
**Console:** Refunds (`/refunds`). Each card is a queue; click one to list it.

---

## How a refund normally moves

Refunding an instalment, or approving an order return, records what is owed
(`refunds` row, `refund_payable` credited) in the same transaction as the
refund itself. Nothing has been paid yet. The worker then:

1. **sends** each unsent Paystack refund (`POST /refund`), and
2. **reconciles** the ones in flight, asking Paystack what became of them.

When Paystack reports the refund processed, the row is `succeeded` and
`refund_payable` is debited against `paystack_settlement['main']`. That is the
only point at which the customer has been paid.

**Paystack's refund API takes no client reference.** Sending the same refund
twice creates two refunds. Everything below is shaped by that: a refund that
_may_ have reached Paystack is never sent again, and never paid by hand while
Paystack may be paying it.

---

## The queues

| Queue                   | Meaning                                                          | Who acts          |
| ----------------------- | ---------------------------------------------------------------- | ----------------- |
| **To send**             | Not sent yet.                                                    | The worker        |
| **With Paystack**       | Paystack holds a refund for it and is processing it.             | The reconciler    |
| **Unresolved**          | Sent, or possibly sent, and no refund found at Paystack yet.     | A person — see §2 |
| **Refused by Paystack** | Paystack refused it, or reported it failed. Customer still owed. | A person — see §1 |
| **To pay by hand**      | The money came in outside Paystack; it goes back that way.       | A person — see §3 |
| **Paid**                | Done.                                                            | —                 |

"With Paystack" includes a refund whose send timed out but which the
reconciler then found at Paystack: it is being paid, whatever happened to the
send. The dashboard's "Refunds needing a person" card counts the three queues
that need a person: refused, unresolved and to pay by hand.

Each row shows our refund reference and, under it, the **charge** — the
original payment as Paystack knows it. That is what to look up in the Paystack
dashboard.

---

## 1. Refused by Paystack (`failed`)

Paystack refused to create the refund — the row's reason says why, in
Paystack's words (`Refund amount exceeds transaction amount`, `Transaction not
found`, …) — or created it and later reported it failed. Either way Paystack
will not pay it.

1. Read the reason. If it points at our data (wrong amount, wrong charge),
   raise it with engineering before paying anything — the books may be wrong
   too.
2. Otherwise pay the customer another way: a Mobile Money transfer to the
   number on their profile, or a bank transfer.
3. In the console, **Mark paid by hand**, and record how in the note
   (`MoMo transfer to 024…, ref 7781`). This books the discharge and closes
   the refund. The note and who recorded it are in the audit trail.

## 2. Unresolved

The send may or may not have reached Paystack — a timeout, a dropped
connection, a crash between sending and recording. Every 5 minutes the
reconciler looks the charge up at Paystack and lists its refunds:

- one refund of this amount that no other row has claimed → it adopts it, and
  the row moves to **With Paystack**;
- anything else → the row stays here, and the reconciler writes what it saw
  as the row's reason, starting `Reconciler:`.

A refund sent less than two minutes ago cannot be marked paid at all: its
call may still be out.

**Do not send it again.** Read the reason:

- **`Reconciler: no refund at Paystack for this charge`** — Paystack holds
  nothing for the charge. Confirm it yourself: in the Paystack dashboard, open
  **Transactions**, find the charge shown on the row, and look at its refunds.
  If there are none, nothing will ever pay this customer: pay them another
  way, then **Mark paid by hand**. You will be asked to tick that you checked
  the Paystack dashboard and found no refund, and to say how you paid; the API
  refuses without both.
- **`Reconciler: N refund(s) at Paystack for this charge, none an unclaimed match`**
  — Paystack holds refunds on the charge, but none the reconciler could tell
  is this one (usually two of the same amount). **Pay nothing.** Find the right
  one in the dashboard and give engineering its refund id: once it is recorded
  on the row (`refunds.paystack_refund_id`), the next reconciliation follows it.
- **`Reconciler: could not verify at Paystack: …`** — Paystack or the network
  failed. It retries every 5 minutes; act only if it persists.
- A send error with no `Reconciler:` reason — the reconciler has not looked
  yet. Wait for the next run.
- Any other `Reconciler:` reason (no charge reference, no transaction id from
  Paystack) — raise it with engineering. Pay nothing until it is understood.

## 3. To pay by hand (`manual`)

The original payment never went through Paystack, so there is no charge to
refund against:

- an instalment recorded as a manual payment (cash to a field agent, a bank
  transfer);
- an order whose payment was confirmed in the console as **Outside Paystack**.

Pay it back the same way, then **Mark paid by hand** with how.

A refund can be marked paid by hand once. A second attempt is refused with the
time it was paid, so two people paying the same customer find out before the
second payment, not after.

## 4. With Paystack, for a long time (`pending_confirmation`)

Paystack holds the refund and is processing it. Mobile Money refunds can take
days. Nothing to do unless it is weeks old; then check the refund in the
Paystack dashboard and raise it with Paystack support. **Never** pay one of
these by hand: Paystack is already paying it, and the API refuses.

## 5. Paystack reports processed a refund recorded refused, or paid by hand

The webhook alert reads `Paystack reports it processed, but it was already
paid by hand — the customer may have been paid twice`, or `… but it is recorded
as refused`. The event is closed and nothing is booked, so the books still show
the one payment they know of.

1. In the Paystack dashboard, confirm the refund really was processed, and for
   how much.
2. If the customer was also paid by hand, they have been paid twice. Contact
   them to recover the duplicate, and tell finance: the books show one payment
   out, and the provider balance will show the other.
3. If the row is `failed` and nobody has paid it by hand, the customer has
   their money. Do **not** pay it by hand; raise it with engineering to record
   the Paystack refund against the row.

---

## Endpoints

```
GET  /admin/refunds?queue=failed            # plans:read — list one queue
GET  /admin/refunds/summary                 # plans:read — count and amount per queue
GET  /admin/refunds/plan/<planId>           # plans:read — one plan's refunds
POST /admin/refunds/<reference>/send        # refunds:act + Idempotency-Key — to_send only
POST /admin/refunds/<reference>/settle-manual
     { "note": "...", "checked_paystack": true }   # refunds:act + Idempotency-Key
```

## Queries

```sql
-- Everything still owed, oldest first.
SELECT reference, status, method, amount_pesewas, requested_at, submitted_at,
       paystack_refund_id, last_error
FROM refunds
WHERE status NOT IN ('succeeded')
ORDER BY requested_at;

-- What the books say is still owed back, per owner. Should match the above.
SELECT account_ref, sum(CASE direction WHEN 'credit' THEN amount_pesewas ELSE -amount_pesewas END) AS owed
FROM ledger_entries
WHERE account_type = 'refund_payable'
GROUP BY account_ref
HAVING sum(CASE direction WHEN 'credit' THEN amount_pesewas ELSE -amount_pesewas END) <> 0;

-- Refunds paid by hand: their cash left outside Paystack.
SELECT transaction_id, amount_pesewas, occurred_at
FROM ledger_entries
WHERE transaction_id LIKE 'refund-paid:%'
  AND account_type = 'paystack_settlement' AND account_ref = 'manual';
```

A refund Paystack paid books its cash out of `paystack_settlement['main']`,
which is what Paystack should be holding for us. One paid by hand books it out
of `paystack_settlement['manual']`, so it never disturbs that figure.
