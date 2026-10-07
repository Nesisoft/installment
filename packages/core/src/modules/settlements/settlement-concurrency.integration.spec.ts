import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, schema } from '@installment/db';
import { AuditLogger } from '../audit/audit-logger.service';
import { SYSTEM_ACTORS } from '../../shared/constants/system-actors';
import { MerchantsService } from '../merchants/merchants.service';
import { LedgerService } from '../../shared/ledger/ledger.service';
import { SettlementService, type PayoutTransferClient } from './settlement.service';

const RUN_DB = Boolean(process.env.DATABASE_URL);

/** A transfer client whose outcome can be changed between runs. */
function scriptedTransfers(): PayoutTransferClient & {
  calls: Array<{ amount: number; reference: string }>;
  status: string;
} {
  const api = {
    calls: [] as Array<{ amount: number; reference: string }>,
    status: 'success',
    async initiateTransfer(req: { amount: number; recipient: string; reference: string }) {
      api.calls.push({ amount: req.amount, reference: req.reference });
      return {
        data: {
          transfer_code: `TRF_${api.calls.length}`,
          reference: req.reference,
          status: api.status,
        },
      };
    },
  };
  return api;
}

/**
 * `settleMerchant`'s idempotency guard under concurrency.
 *
 * `confirmPayout` carries a comment describing a TOCTOU this project already
 * found and closed: a row "read outside any transaction and without FOR UPDATE",
 * so two runs could both pass the terminal-state check and both act. The same
 * shape survived in `settleMerchant` — the method that actually sends the money.
 *
 * On a first settlement `UNIQUE(merchant_id, as_of_date)` serialises the INSERT.
 * On a RETRY (the row is `failed`/`reversed`, its ledger debit already reversed,
 * so the balance is owed again) both runs UPDATE the same row and each books a
 * ledger debit under its own fresh provider reference — and a fresh reference is
 * a different `transaction_id`, so `ledger_posting_identity_uq` does not collide.
 * Two debits, two transfers, one merchant paid twice.
 */
describe.skipIf(!RUN_DB)('settlement concurrency (integration)', () => {
  const { db, pool } = createTestDb();
  const audit = new AuditLogger();
  const ledger = new LedgerService(db);
  const merchants = new MerchantsService(db, audit);
  const ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  afterAll(async () => {
    await pool.end();
  });

  async function merchantOwed(amountPesewas: number): Promise<string> {
    const suffix = randomUUID();
    const merchant = await merchants.create(
      {
        business_name: `MC ${suffix}`,
        legal_name: `MC Ltd ${suffix}`,
        email: `mc+${suffix}@x.gh`,
        phone: '+233244000000',
      },
      ACTOR,
    );
    await db
      .update(schema.merchants)
      .set({ status: 'active', paystack_recipient_code: `RCP_${suffix}` })
      .where(eq(schema.merchants.id, merchant.id));
    await ledger.record([
      {
        transactionId: `seed:${merchant.id}`,
        accountType: 'receivable',
        accountRef: merchant.id,
        direction: 'debit',
        amountPesewas,
        description: 'seed receivable',
      },
      {
        transactionId: `seed:${merchant.id}`,
        accountType: 'merchant_payable',
        accountRef: merchant.id,
        direction: 'credit',
        amountPesewas,
        description: 'seed payable',
      },
    ]);
    return merchant.id;
  }

  /**
   * Holds the first two callers of `balanceOf` for this merchant until both
   * have read, so both see the pre-retry balance. That read sits outside the
   * transaction, which is precisely the window being tested.
   */
  function raceGate(merchantId: string) {
    const real = ledger.balanceOf.bind(ledger);
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    return vi.spyOn(ledger, 'balanceOf').mockImplementation(async (accountType, accountRef, tx) => {
      const value = await real(accountType, accountRef, tx);
      if (accountType === 'merchant_payable' && accountRef === merchantId) {
        arrived += 1;
        if (arrived >= 2) release();
        else await gate;
      }
      return value;
    });
  }

  it('two concurrent retries of a failed payout debit the merchant once, not twice', async () => {
    const AMOUNT = 50_000;
    const merchantId = await merchantOwed(AMOUNT);
    const transfers = scriptedTransfers();
    const settlements = new SettlementService(db, ledger, audit, transfers);

    // First run fails the transfer: the payout row lands on `failed` and its
    // ledger debit is reversed, so the balance is owed again.
    transfers.status = 'failed';
    const first = await settlements.settleMerchant(merchantId);
    expect(first.status).toBe('failed');
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(AMOUNT);

    // Now two retries race, both seeing the `failed` row and the restored balance.
    transfers.status = 'success';
    const before = transfers.calls.length;
    const spy = raceGate(merchantId);
    try {
      await Promise.all([
        settlements.settleMerchant(merchantId),
        settlements.settleMerchant(merchantId),
      ]);
    } finally {
      spy.mockRestore();
    }

    // The merchant is owed nothing and is not owed money BACK: a second debit
    // drives the payable negative, which is the platform having paid twice.
    const balance = await ledger.balanceOf('merchant_payable', merchantId);
    expect(balance).toBe(0);

    // And exactly one transfer went out for the retry.
    expect(transfers.calls.length - before).toBe(1);

    // One payout row for the day, per UNIQUE(merchant_id, as_of_date).
    const rows = await db
      .select()
      .from(schema.payouts)
      .where(eq(schema.payouts.merchant_id, merchantId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount_pesewas).toBe(AMOUNT);
  });

  it('two concurrent first settlements pay the merchant once', async () => {
    const AMOUNT = 30_000;
    const merchantId = await merchantOwed(AMOUNT);
    const transfers = scriptedTransfers();
    const settlements = new SettlementService(db, ledger, audit, transfers);

    const spy = raceGate(merchantId);
    let results;
    try {
      results = await Promise.allSettled([
        settlements.settleMerchant(merchantId),
        settlements.settleMerchant(merchantId),
      ]);
    } finally {
      spy.mockRestore();
    }

    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(0);
    expect(transfers.calls).toHaveLength(1);

    // Whatever the loser does, it must not be a second payment. Surfacing it
    // as a rejection or as a skip are both acceptable; paying twice is not.
    const settled = results.filter((r) => r.status === 'fulfilled' && r.value.status === 'settled');
    expect(settled).toHaveLength(1);
  });
});
