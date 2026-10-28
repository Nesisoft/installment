# Runbook — instalment collection and collections cases

**Alerts:**

- `stuck installments need manual reconciliation` (error), from the stuck-schedule sweep (hourly),
  and `installment stuck in processing` (error), one per instalment — a charge we cannot tell
  succeeded or failed (§1);
- `MoMo telco <MTN|TGO|VOD> is <degraded|down>` (every 5 minutes) — Mobile Money debits on that
  network are failing more than usual (§2);
- `N Paystack decline reasons not in the classifier map — treated as ambiguous and retried`
  (warning) — Paystack sent decline wording we do not recognise (§2);
- a worker error tagged `collections` — the 08:00 collections sweep failed outright (§3).

**Severity:** high for a stuck instalment (money may have moved without being recorded); medium
otherwise.
**Console:** Collections (`/collections`) for cases; Plan operations (`/plans`) to find a plan and
record a payment made outside the system.

---

## How an instalment is collected

1. **The day before** it is due, at 17:00, the customer is texted that it will be charged — on the
   saved card, the MoMo wallet, or, with neither saved, asked to pay in the app.
2. **On the due date** the hourly debit sweep charges it: a saved card first, else Mobile Money.
   The instalment is `processing` until Paystack answers.
3. **A failed charge** is retried on a ladder (the retry queue, in Redis). After a declined card
   the next try goes to Mobile Money when a number is on file, and back again. The customer may
   be sent a payment link to pay it themselves.
4. **Past its grace period** (set on the plan template), an unpaid instalment becomes `overdue`,
   and the 08:00 collections sweep opens a **case** for it. The instalment moves to
   `in_collections`.
5. Each day the sweep moves open cases on by age, and texts the customer on entering a stage
   marked ✉:

   | Case age (days) | Stage               |     |
   | --------------- | ------------------- | --- |
   | 0               | Soft reminder       | ✉   |
   | 3               | Firm reminder       | ✉   |
   | 7               | Restriction warning | ✉   |
   | 14              | Agent assigned      |     |
   | 30              | Field visit         |     |
   | 60              | Legal threat        | ✉   |
   | 90              | Write-off           |     |

6. **At write-off** the plan is defaulted. The loss is taken from the seller's reserve first; past
   that, Ejua carries it on BNPL, rent-to-own and layaway, and the seller on hybrid.
7. **A case closes itself** on the next sweep once its instalment is paid, however it was paid.

---

## 1. An instalment stuck in `processing`

A charge was started and no outcome ever arrived. The hourly sweep re-checks every instalment that
has been `processing` for more than 90 minutes against Paystack, and settles or fails it when
Paystack has an answer. The alert means it could not. Each alert names the instalment, how long it
has been stuck and, where there is one, the attempt and its Paystack reference:

- **unresolved** — Paystack gave no usable answer for the attempt (the alert says what it said);
- **orphaned** — no attempt is in flight. Either the process stopped between marking the
  instalment and charging, or an attempt finished and the instalment did not follow.

For each one:

1. Look the Paystack reference up in the Paystack dashboard (Transactions, search by reference).
   For an orphaned instalment there is no reference in the alert; engineering can list its
   attempts.
2. **Paystack shows a successful charge** — the customer has paid. Raise it with engineering to
   apply it. **Do not use Record payment** in Plan operations: that books the money as received
   outside Paystack, and the books would then disagree with the Paystack balance.
3. **Paystack shows it failed, or has no such transaction** — the customer was not charged.
   Raise it with engineering to return the instalment to the retry ladder.
4. Never charge the customer again by another route while the instalment is `processing`. If the
   first charge did succeed, that is a double charge.

## 2. Telco degraded, or unrecognised decline reasons

**`MoMo telco … is degraded/down`.** Debits on that network are failing beyond the threshold.
Failures there are retried on the ladder as usual; nothing has to be done to the instalments. Check
Paystack's status page and the telco's. If it lasts beyond a day, expect more instalments to pass
their grace period and open cases that are not the customer's fault — use judgement when an agent
contacts them.

**Unrecognised decline reasons.** Paystack sent decline wording the classifier does not know. It
is treated as ambiguous and retried, which is the safe choice. The alert lists the wording and how
often it was seen. Pass it to engineering to add to the classifier map, so a definite decline
("insufficient funds", "card expired") is not retried pointlessly and an outage is not mistaken for
the customer's fault.

## 3. The collections sweep failed

The 08:00 sweep threw before finishing. Nothing moved that day: grace periods did not expire into
cases, cases did not advance, and paid cases did not close. It runs again tomorrow and catches up —
every step goes by date, so a missed day is made up, not skipped. If it fails two days running,
raise it with engineering with the error from Sentry.

## 4. Working a case

On the case page an agent can:

- **assign** it to themselves or another agent;
- **record an action** — an SMS, email, call, visit scheduled or completed, or a note — with the
  channel, outcome and notes. This is the case's history; record every contact.
- **close** it, as one of:
  - **Paid** — only once the instalment is actually paid. It is refused otherwise. Usually
    unnecessary: the sweep closes paid cases itself.
  - **Waived** — the instalment is forgiven: marked `waived`, never collected. A decision with
    money attached; say why in the notes, which go on the audit trail.

There is no "restructured" close: nothing issues a replacement plan yet, and closing a case that
way would strand the instalment, owed and never looked at again.

**The customer paid outside the system** (cash at the shop, a bank transfer): in Plan operations,
open the plan and **Record payment** on the instalment. It settles the instalment and books the
money as received outside Paystack; the next sweep closes the case. The console does not ask for a
reference, so record one on the case as an action ("Bank transfer, GCB ref 7781").

Only for money that did not come through Paystack — see §1.

---

## What not to do

- **Do not close a case as Waived to make it go away.** It forgives the money.
- **Do not record a payment you have not seen, or one that came through Paystack.** Recording one
  tells the books money arrived outside Paystack.
- **Do not charge a customer through a payment link or by hand while an instalment is
  `processing`** — see §1.
