# Runbook — merchant payouts that did not go out

**Alerts:**

- `No merchant payout went out on <date> — N refused or unconfirmed, most often: "<reason>"`
  (error) and `N merchant payouts did not go out on <date>` (warning), from the daily settlement
  run (`SettlementCron`, 06:00 server time — UTC, as the job assumes);
- `payouts could not be reconciled` (error), from the payout reconciler (`ReconciliationCron`,
  every 30 minutes);
- `paystack webhook not applied` (error) naming a `transfer.*` event — Paystack moved money on a
  transfer we could not match to a payout (§5).

**Severity:** high — a seller is owed money and has not received it, or may have been paid twice.
**Console:** Merchants → the merchant → **Recent payouts**. There is no payouts list across
merchants; the alert's `payouts` list names each merchant and reference.
**API:** `POST /admin/settlements/run`, `POST /admin/settlements/merchants/:merchantId/run` and
`POST /admin/settlements/reconcile`, all needing `settlements:run`.

---

## How a payout normally moves

Every day at 06:00 the settlement run pays each merchant whose `merchant_payable` balance is
positive. For each one it first **books** the payout, then **sends** it:

1. In one transaction: a `payouts` row (`initiated`), and the ledger entries that clear what we
   owe — debit `merchant_payable[merchant]`, credit `paystack_settlement['main']`.
2. A Paystack transfer to the merchant's recipient code, with the payout's `reference`.

Booking before sending is what makes a crash safe: the balance is already cleared, so a second
run cannot pay it again. The transfer's answer decides the row's status:

| Status                 | Meaning                                                                      |
| ---------------------- | ---------------------------------------------------------------------------- |
| `settled`              | Paystack paid it.                                                            |
| `pending_confirmation` | Paystack accepted it and has not finished; the reconciler or a webhook will. |
| `unknown`              | The call errored mid-flight — we do not know if Paystack has it.             |
| `failed`               | Paystack refused it or reported it failed. The payable is restored.          |
| `reversed`             | Paystack paid it, then sent it back (bank or wallet rejected it). Restored.  |

A `failed` or `reversed` payout puts the money back in `merchant_payable`: the seller is owed it
again and the next run pays it. Nothing is lost; it is late.

Every 30 minutes the reconciler asks Paystack about each `pending_confirmation` and `unknown`
payout (oldest first, 100 per sweep):

- **success** → `settled`;
- **failed** → `failed`, and **reversed** → `reversed`; the payable is restored either way;
- **still pending** → left for the next sweep;
- **not found, on an `unknown` payout** → the transfer never reached Paystack, so `failed`,
  payable restored, and the reason keeps why initiating it failed;
- **any other error** → left alone and reported as unresolved. The reconciler never reverses a
  payout it is unsure about: that risks paying twice.

`transfer.success`, `transfer.failed` and `transfer.reversed` webhooks apply the same outcomes as
they arrive, usually before the reconciler gets there.

---

## Merchants the run skips

A skip is not an alert: the balance stays owed and a later run pays it. The run's log line counts
them; the reasons are:

| Reason                                              | What to do                                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `merchant not active`                               | Nothing, unless the merchant should be active. A suspended merchant is not paid until reinstated. |
| `no Paystack recipient code`                        | The merchant has no payout account. The console's merchant page says so; the seller adds one.     |
| `payout account changed recently — held until …`    | The seller changed their payout account in the last 24 hours. Paid on the first run after.        |
| `below minimum payout (… pesewas) — rolled forward` | Less than the merchant's floor (GHS 100 by default). Paid once the balance reaches it.            |

---

## 1. "No merchant payout went out"

Every attempted transfer was refused or left unconfirmed. One seller's bad account number does not
do that; the account or the configuration does.

1. Read the reason in the alert. The one seen in test mode on 2026-10-20 was Paystack's
   **"You cannot initiate third party payouts as a starter business"** — transfers are not
   enabled on the Paystack account. That is fixed with Paystack (business verification and
   transfers enabled), not in our system.
2. Check the Paystack balance covers the run; an insufficient balance refuses transfers too.
3. Once the cause is fixed, wait for the reconciler to resolve the `unknown` rows (they become
   `failed` with the payable restored), then run `POST /admin/settlements/run`. It retries every
   merchant whose payout today `failed` or was `reversed`, under a new provider reference; a
   payout already `settled` or still in flight is left alone. If you do nothing, tomorrow's
   run pays the restored balances.

## 2. Some payouts did not go out

The alert lists each merchant, status, amount and reference, grouped by reason.

- **`failed` with a reason about the account** (invalid account, recipient not found, name
  mismatch): the seller's payout account is wrong. Ask them to correct it in the seller app or on
  the seller website. The change is held for 24 hours, by design, and the next run after that pays.
- **`unknown`**: wait for the reconciler — normally within 30 minutes. If it stays `unknown`
  past a few sweeps, see §3.
- To pay one merchant again the same day, after fixing the cause:
  `POST /admin/settlements/merchants/:merchantId/run`. It pays their current balance when today's
  payout `failed` or was `reversed` (or there is none yet); a payout already `settled` or in
  flight is left alone.

## 3. "Payouts could not be reconciled"

The reconciler could not get an answer from Paystack, or could not apply the one it got. The
payout is untouched and retried every 30 minutes; the alert lists the references.

1. Look each reference up in the Paystack dashboard (Transfers, search by reference).
2. If Paystack shows it **successful**, and the reconciler keeps failing to apply it, that is a
   defect — raise it with engineering. Do not pay the seller by hand: they have been paid.
3. If Paystack shows it **failed** or has **no such transfer**, the next successful sweep will
   restore the payable. Do not pay by hand while the row is `unknown` or `pending_confirmation` —
   the next run would pay the restored balance too.
4. `POST /admin/settlements/reconcile` runs a sweep immediately.

## 4. A seller says they were not paid

1. Merchants → the merchant → **Recent payouts**. Find the day.
2. `settled` — Paystack reports it paid. Give the seller the reference; their bank or MoMo
   provider can trace it. If Paystack later reverses it, it becomes `reversed` and is paid again
   (§5).
3. `failed` / `reversed` — the money is back in their balance and goes out on the next run, once
   the cause (usually the account) is fixed. The seller app shows them a plain-language version
   of the reason.
4. No row for the day — the run skipped them. Check the table above.

## 5. A reversal after settlement, and unmatched transfer webhooks

Paystack can reverse a GHS transfer days after reporting it successful, when the receiving bank
or wallet rejects it. The `transfer.reversed` webhook (or the reconciler) marks the payout
`reversed` and restores the seller's balance; the next run pays it again. Have the seller check
the account they are paid to before then.

`paystack webhook not applied` on a `transfer.*` event means Paystack reports a transfer with a
reference we have no payout for. That is money moving on our account that our books do not
explain. Look the reference up in Paystack, and raise it with engineering with the event; do not
adjust balances by hand.

---

## What not to do

- **Do not pay a seller by hand for a payout that is `settled`, `pending_confirmation` or
  `unknown`.** The ledger has already cleared that balance; paying it again outside the system
  pays twice and leaves the books unable to show it.
- **Do not edit `payouts` rows or ledger entries.** The ledger is append-only; corrections go
  through the services, or the money-repairs tool ([`money-repairs.md`](./money-repairs.md)).
