# Runbook — refunds that have not reached the customer

**Alerts:** `refunds could not be sent`, `refunds could not be reconciled`
**Source:** `RefundCron` (every 5 minutes)
**Severity:** high — a customer is waiting for money we owe them.
**Console:** Refunds (`/refunds`). Each card is a queue; click one to list it.

---

## How a refund normally moves

Refunding an instalment, or approving an order return, records what is owed
(`refunds` row, `refund_payable` credited) in the same transaction as the
refund itself. Nothing has been paid yet. The worker then:

1. **sends** each unsent Paystack refund (`POST /refund`), and
2. **reconciles** the ones in flight, asking Paystack what became of them.

When Paystack reports the refund processed, the row is `succeeded` and
`refund_payable` is debited against `paystack_settlement`. That is the only
point at which the customer has been paid.

**Paystack's refund API takes no client reference.** Sending the same refund
twice creates two refunds. Everything below is shaped by that: a refund that
_may_ have reached Paystack is never sent again.

---

## The queues

| Queue                   | Meaning                                                    | Who acts          |
| ----------------------- | ---------------------------------------------------------- | ----------------- |
| **To send**             | Not sent yet.                                              | The worker        |
| **With Paystack**       | Paystack accepted it; outcome pending.                     | The reconciler    |
| **Unresolved**          | Sent, or possibly sent, with no usable answer.             | A person — see §2 |
| **Refused by Paystack** | Paystack declined to create it. Customer still owed.       | A person — see §1 |
| **To pay by hand**      | The money came in outside Paystack; it goes back that way. | A person — see §3 |
| **Paid**                | Done.                                                      | —                 |

The dashboard's "Refunds needing a person" card counts the last three that
need a person: refused, unresolved and to pay by hand.

---

## 1. Refused by Paystack (`failed`)

Paystack answered and said no — the row's reason says why, in Paystack's
words (`Refund amount exceeds transaction amount`, `Transaction not found`,
…). No refund exists at Paystack and none will.

1. Read the reason. If it points at our data (wrong amount, wrong charge),
   raise it with engineering before paying anything — the books may be wrong
   too.
2. Otherwise pay the customer another way: a Mobile Money transfer to the
   number on their profile, or a bank transfer.
3. In the console, **Mark paid by hand**, and record how in the note
   (`MoMo transfer to 024…, ref 7781`). This books the discharge and closes
   the refund. The note and who recorded it are in the audit trail.

## 2. Unresolved (`unknown`, or claimed for sending with nothing recorded)

The send may or may not have reached Paystack — a timeout, a dropped
connection, a crash between sending and recording. The reconciler keeps
looking: it finds the refund at Paystack by the charge's id when it can, and
settles or fails it from there. A row stays here when it cannot.

**Do not send it again.** Instead:

1. Copy the row's **charge** reference (shown under the refund reference).
2. In the Paystack dashboard, open **Transactions**, find that charge, and look
   at its refunds.
3. **If the charge shows a refund for this amount**, do not pay anything.
   Paystack has it. The reconciler could not tell which refund is this one
   (the row's reason says what it saw — usually two refunds of the same
   amount). Give engineering the Paystack refund id: once it is recorded on
   the row (`refunds.paystack_refund_id`), the next reconciliation settles or
   fails it from Paystack's own answer.
4. **If the charge shows no refund**, nothing will ever pay this customer.
   Pay them another way, then **Mark paid by hand**: tick that you checked the
   Paystack dashboard and found no refund, and record how you paid. The API
   refuses this without both.

## 3. To pay by hand (`manual`)

The original payment never went through Paystack — cash to a field agent, a
manual bank transfer — so there is no charge to refund against. Pay it back
the same way, then **Mark paid by hand** with how.

## 4. With Paystack, for a long time (`pending_confirmation`)

Paystack accepted it and is processing. Mobile Money refunds can take days.
Nothing to do unless it is weeks old; then check the refund in the Paystack
dashboard and raise it with Paystack support. **Never** pay one of these by
hand: Paystack is already paying it, and the API refuses.

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
SELECT reference, status, method, amount_pesewas, requested_at, submitted_at, last_error
FROM refunds
WHERE status NOT IN ('succeeded')
ORDER BY requested_at;

-- What the books say is still owed back, per owner. Should match the above.
SELECT account_ref, sum(CASE direction WHEN 'credit' THEN amount_pesewas ELSE -amount_pesewas END) AS owed
FROM ledger_entries
WHERE account_type = 'refund_payable'
GROUP BY account_ref
HAVING sum(CASE direction WHEN 'credit' THEN amount_pesewas ELSE -amount_pesewas END) <> 0;
```

A refund paid by hand books the same entries as one Paystack paid
(`refund-paid:<reference>`), so the second query goes to zero either way.
