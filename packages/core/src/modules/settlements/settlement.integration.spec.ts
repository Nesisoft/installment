import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createDb, schema } from '@installment/db';
import { AuditLogger } from '../audit/audit-logger.service';
import { SYSTEM_ACTORS } from '../../shared/constants/system-actors';
import { MerchantsService } from '../merchants/merchants.service';
import { LedgerService } from '../../shared/ledger/ledger.service';
import {
  SETTLEMENT_CASH_REF,
  SettlementService,
  type PayoutTransferClient,
} from './settlement.service';

const RUN_DB = Boolean(process.env.DATABASE_URL);

/** Records transfer calls and returns a scripted status. */
function fakeTransfers(status = 'success'): PayoutTransferClient & {
  calls: Array<{ amount: number; recipient: string; reference: string }>;
} {
  const calls: Array<{ amount: number; recipient: string; reference: string }> = [];
  return {
    calls,
    async initiateTransfer(req) {
      calls.push({ amount: req.amount, recipient: req.recipient, reference: req.reference });
      return { data: { transfer_code: `TRF_${calls.length}`, reference: req.reference, status } };
    },
  };
}

function throwingTransfers(message: string): PayoutTransferClient {
  return {
    async initiateTransfer() {
      throw new Error(message);
    },
  };
}

describe.skipIf(!RUN_DB)('SettlementService (integration)', () => {
  const { db, pool } = createDb({ connectionString: process.env.DATABASE_URL! });
  const audit = new AuditLogger();
  const ledger = new LedgerService(db);
  const merchants = new MerchantsService(db, audit);
  const ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  afterAll(async () => {
    await pool.end();
  });

  /** Creates an active merchant with a recipient code and seeds a payable balance. */
  async function merchantOwed(amountPesewas: number, opts: { recipient?: boolean } = {}) {
    const suffix = randomUUID();
    const merchant = await merchants.create(
      {
        business_name: `M ${suffix}`,
        legal_name: `M Ltd ${suffix}`,
        email: `m+${suffix}@x.gh`,
        phone: '+233244000000',
      },
      ACTOR,
    );
    // Activate + (optionally) attach a recipient code directly.
    await db
      .update(schema.merchants)
      .set({
        status: 'active',
        paystack_recipient_code: opts.recipient === false ? null : `RCP_${suffix}`,
      })
      .where(eq(schema.merchants.id, merchant.id));

    if (amountPesewas > 0) {
      // Seed a balanced transaction that leaves merchant_payable owing.
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
    }
    return merchant.id;
  }

  it('settles a merchant: clears the payable, books the cash-out, marks the payout settled', async () => {
    const merchantId = await merchantOwed(50_000);
    const transfers = fakeTransfers('success');
    const settlement = new SettlementService(db, ledger, audit, transfers);

    const result = await settlement.settleMerchant(merchantId, new Date('2026-06-01'));

    expect(result.status).toBe('settled');
    expect(result.amountPesewas).toBe(50_000);
    expect(transfers.calls).toHaveLength(1);
    expect(transfers.calls[0]).toMatchObject({
      amount: 50_000,
      recipient: expect.stringMatching(/^RCP_/),
    });

    // Payable cleared; cash account credited the same amount.
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(0);
    // Assert this payout's own credit, not the global cash balance. Since S5
    // books the inbound leg, paystack_settlement is no longer monotonically
    // positive — collections debit it — so its aggregate balance says nothing
    // about whether this particular cash-out was booked.
    const cashOut = await db
      .select({ amount: schema.ledger_entries.amount_pesewas })
      .from(schema.ledger_entries)
      .where(
        and(
          // Keyed on the attempt's reference, not the payout row id: a
          // same-day retry reuses the row, so the id is not unique per attempt.
          eq(schema.ledger_entries.transaction_id, result.reference!),
          eq(schema.ledger_entries.account_type, 'paystack_settlement'),
          eq(schema.ledger_entries.account_ref, SETTLEMENT_CASH_REF),
          eq(schema.ledger_entries.direction, 'credit'),
        ),
      );
    expect(cashOut).toHaveLength(1);
    expect(cashOut[0]!.amount).toBe(50_000);

    const payout = (
      await db.select().from(schema.payouts).where(eq(schema.payouts.merchant_id, merchantId))
    )[0];
    expect(payout!.status).toBe('settled');
    expect(payout!.amount_pesewas).toBe(50_000);
    expect(payout!.settled_at).not.toBeNull();
    expect(payout!.reference).toBe(`payout:${merchantId}:2026-06-01`);
  });

  it('is idempotent — a second run on the same day does not create a second payout', async () => {
    const merchantId = await merchantOwed(30_000);
    const transfers = fakeTransfers('success');
    const settlement = new SettlementService(db, ledger, audit, transfers);
    const asOf = new Date('2026-06-02');

    await settlement.settleMerchant(merchantId, asOf);
    const second = await settlement.settleMerchant(merchantId, asOf);

    expect(second.reason).toBe('already settled today');
    expect(transfers.calls).toHaveLength(1); // not called again
    const rows = await db
      .select()
      .from(schema.payouts)
      .where(eq(schema.payouts.merchant_id, merchantId));
    expect(rows).toHaveLength(1);
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(0);
  });

  it('skips a merchant with no balance, no recipient code, or not active', async () => {
    const settlement = new SettlementService(db, ledger, audit, fakeTransfers());

    const noBalance = await merchantOwed(0);
    expect((await settlement.settleMerchant(noBalance)).status).toBe('skipped');

    const noRecipient = await merchantOwed(10_000, { recipient: false });
    const r = await settlement.settleMerchant(noRecipient);
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe('no Paystack recipient code');
    expect(await ledger.balanceOf('merchant_payable', noRecipient)).toBe(10_000); // untouched
  });

  it('reverses the ledger and marks failed when the transfer is rejected', async () => {
    const merchantId = await merchantOwed(20_000);
    const settlement = new SettlementService(db, ledger, audit, fakeTransfers('failed'));

    const result = await settlement.settleMerchant(merchantId, new Date('2026-06-03'));

    expect(result.status).toBe('failed');
    // Reversal restored the payable; net cash movement is zero.
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(20_000);

    const payout = (
      await db.select().from(schema.payouts).where(eq(schema.payouts.merchant_id, merchantId))
    )[0];
    expect(payout!.status).toBe('failed');
    expect(payout!.failed_at).not.toBeNull();
    expect(payout!.last_error).toContain('failed');
  });

  it('parks as unknown (ledger stays debited) when the transfer call throws', async () => {
    const merchantId = await merchantOwed(15_000);
    const settlement = new SettlementService(
      db,
      ledger,
      audit,
      throwingTransfers('network timeout'),
    );

    const result = await settlement.settleMerchant(merchantId, new Date('2026-06-04'));

    expect(result.status).toBe('unknown');
    // Liability already cleared and NOT auto-reversed (avoids double-pay risk).
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(0);

    const payout = (
      await db.select().from(schema.payouts).where(eq(schema.payouts.merchant_id, merchantId))
    )[0];
    expect(payout!.status).toBe('unknown');
    expect(payout!.last_error).toContain('network timeout');

    // Reconciliation later confirms failure → reverse + restore the payable.
    await settlement.confirmPayout(payout!.reference, 'failed', { error: 'not found at Paystack' });
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(15_000);
    const after = (
      await db.select().from(schema.payouts).where(eq(schema.payouts.id, payout!.id))
    )[0];
    expect(after!.status).toBe('failed');
  });

  it('confirmPayout settles a pending transfer and is idempotent on terminal payouts', async () => {
    const merchantId = await merchantOwed(12_000);
    const settlement = new SettlementService(db, ledger, audit, fakeTransfers('pending'));

    const result = await settlement.settleMerchant(merchantId, new Date('2026-06-05'));
    expect(result.status).toBe('pending_confirmation');
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(0); // already debited

    await settlement.confirmPayout(result.reference!, 'settled', { transferId: 'TRF_ID_1' });
    let payout = (
      await db.select().from(schema.payouts).where(eq(schema.payouts.id, result.payoutId!))
    )[0];
    expect(payout!.status).toBe('settled');
    expect(payout!.paystack_transfer_id).toBe('TRF_ID_1');

    // Idempotent — confirming again is a no-op.
    await settlement.confirmPayout(result.reference!, 'failed', { error: 'late webhook' });
    payout = (
      await db.select().from(schema.payouts).where(eq(schema.payouts.id, result.payoutId!))
    )[0];
    expect(payout!.status).toBe('settled'); // unchanged
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(0);
  });

  it('runDailySettlement settles everyone we owe and totals the settled amount', async () => {
    const a = await merchantOwed(40_000);
    const b = await merchantOwed(60_000);
    const transfers = fakeTransfers('success');
    const settlement = new SettlementService(db, ledger, audit, transfers);

    const summary = await settlement.runDailySettlement(new Date('2026-07-01'));

    const settledA = summary.results.find((r) => r.merchantId === a);
    const settledB = summary.results.find((r) => r.merchantId === b);
    expect(settledA?.status).toBe('settled');
    expect(settledB?.status).toBe('settled');
    expect(await ledger.balanceOf('merchant_payable', a)).toBe(0);
    expect(await ledger.balanceOf('merchant_payable', b)).toBe(0);
    // Total covers at least these two (other merchants from prior tests already cleared).
    expect(summary.totalSettledPesewas).toBeGreaterThanOrEqual(100_000);
  });
});
