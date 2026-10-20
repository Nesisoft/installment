import type { MerchantPayoutRow, MerchantPayoutsPage } from './merchant-dashboard.service';

/**
 * What a seller is told about a payout that did not go out.
 *
 * `last_error` holds the provider's own words, for operations: "You cannot
 * initiate third party payouts as a starter business", "socket hang up",
 * "transfer reversed". The seller's payouts screen printed it as it was, so a
 * merchant whose payout failed read Paystack's account-tier refusal about a
 * business that is not theirs, and could not tell from it what had happened to
 * the money. The admin console keeps the raw text; this is the seller's.
 *
 * Every `failed` and `reversed` row was written by `reverseAndFail`, which
 * credits `merchant_payable` back in the same transaction — so "back in your
 * balance" is a fact about the ledger, not a reassurance. The next settlement
 * run includes that balance — the payouts screen's "In the next payout run"
 * figure already counts it — though whatever stopped this one may stop that
 * one too, which is why the note does not promise it will arrive.
 */
export function sellerPayoutNote(status: string): string | null {
  switch (status) {
    case 'failed':
      return "This payout didn't go through. The money is back in your balance and is included in the next payout run. If this keeps happening, check your payout account.";
    case 'reversed':
      return 'This payout was sent back and did not reach your account. The money is back in your balance and is included in the next payout run.';
    case 'unknown':
      // The ledger is still debited and reconciliation is asking Paystack. The
      // raw text is whatever the transfer call threw — a dropped connection,
      // or a refusal reconciliation has not yet turned into `failed`.
      return "We're still confirming this payout. Nothing to do on your side.";
    default:
      return null;
  }
}

/**
 * A payouts page as the seller's own endpoint returns it.
 *
 * `lastError` carries `sellerPayoutNote` instead of the provider's text, rather
 * than a new field beside it: the seller app already shows `lastError` on a
 * failed row, so builds already on handsets get the plain sentence without an
 * update.
 */
export function payoutsForSeller(page: MerchantPayoutsPage): MerchantPayoutsPage {
  return {
    ...page,
    rows: page.rows.map(
      (row): MerchantPayoutRow => ({ ...row, lastError: sellerPayoutNote(row.status) }),
    ),
  };
}
