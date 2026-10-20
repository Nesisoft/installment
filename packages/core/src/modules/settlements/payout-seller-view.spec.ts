import { describe, expect, it } from 'vitest';
import type { MerchantPayoutRow } from './merchant-dashboard.service';
import { payoutsForSeller, sellerPayoutNote } from './payout-seller-view';

const row = (over: Partial<MerchantPayoutRow>): MerchantPayoutRow => ({
  id: 'p1',
  reference: 'payout:m1:2026-10-20',
  asOfDate: '2026-10-20',
  amountPesewas: 40_000,
  status: 'settled',
  paystackTransferCode: null,
  initiatedAt: '2026-10-20 23:00:00+00',
  settledAt: null,
  failedAt: null,
  lastError: null,
  ...over,
});

// Paystack's answer to a transfer from a starter-tier account, captured in
// test mode — the text a seller was shown on their payouts screen.
const STARTER_REFUSAL = 'You cannot initiate third party payouts as a starter business';

describe('payoutsForSeller', () => {
  it("never shows a seller the provider's own words", () => {
    const page = payoutsForSeller({
      rows: [
        row({ id: 'a', status: 'failed', lastError: STARTER_REFUSAL }),
        row({ id: 'b', status: 'reversed', lastError: 'transfer reversed' }),
        row({ id: 'c', status: 'unknown', lastError: 'socket hang up' }),
      ],
      total: 3,
    });
    for (const r of page.rows) {
      expect(r.lastError).not.toMatch(/starter business|transfer reversed|socket/);
    }
  });

  it('tells the seller where the money is after a payout fails or comes back', () => {
    const [failed, reversed] = payoutsForSeller({
      rows: [
        row({ status: 'failed', lastError: STARTER_REFUSAL }),
        row({ status: 'reversed', lastError: 'transfer reversed' }),
      ],
      total: 2,
    }).rows;
    expect(failed!.lastError).toMatch(/back in your balance/);
    expect(reversed!.lastError).toMatch(/did not reach your account/);
    expect(reversed!.lastError).toMatch(/back in your balance/);
  });

  it('says nothing beside a payout that went out or is on its way', () => {
    for (const status of ['settled', 'initiated', 'pending_confirmation']) {
      expect(sellerPayoutNote(status)).toBeNull();
    }
    const [settled] = payoutsForSeller({
      rows: [row({ status: 'settled', lastError: 'stale text from an earlier attempt' })],
      total: 1,
    }).rows;
    expect(settled!.lastError).toBeNull();
  });

  it('keeps everything else about the page as it was', () => {
    const original = row({ status: 'failed', lastError: STARTER_REFUSAL, failedAt: '2026-10-21' });
    const page = payoutsForSeller({ rows: [original], total: 7 });
    expect(page.total).toBe(7);
    expect(page.rows[0]).toEqual({ ...original, lastError: sellerPayoutNote('failed') });
    // The admin console's copy is untouched.
    expect(original.lastError).toBe(STARTER_REFUSAL);
  });
});
