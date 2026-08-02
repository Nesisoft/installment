import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, schema } from '@installment/db';
import { AuditLogger } from '../audit/audit-logger.service';
import { LedgerService } from '../../shared/ledger/ledger.service';
import { SYSTEM_ACTORS } from '../../shared/constants/system-actors';
import { MerchantsService } from '../merchants/merchants.service';
import { PayoutCalculator } from './payout-calculator';
import { PayoutRecorder } from './payout-recorder';
import { SettlementService, type PayoutTransferClient } from './settlement.service';

const RUN_DB = Boolean(process.env.DATABASE_URL);

/**
 * S8 — pay the right merchant the right amount.
 *
 * `customer_plans.mdr_bps` / `reserve_bps` are snapshotted from the merchant's
 * negotiated terms at activation. They were written, shown in the admin
 * console, and read by nothing: every accrual silently used the model default.
 * On an append-only ledger those accruals can only be compensated, never
 * corrected, so this must be right before the first real merchant.
 */
describe('PayoutCalculator honours per-plan rates', () => {
  it('uses the plan rates over the model defaults', () => {
    // bnpl defaults are 400bps MDR / 500bps reserve.
    const negotiated = PayoutCalculator.calculate(100_000, 'bnpl', 'order_approved', {
      rates: { mdrBps: 250, reserveBps: 0 },
    })!;

    expect(negotiated.grossPesewas).toBe(100_000);
    expect(negotiated.mdrPesewas).toBe(2_500); // 2.5%, not the default 4%
    expect(negotiated.reservePesewas).toBe(0); // 0%, not the default 5%
    expect(negotiated.netPesewas).toBe(97_500);
    expect(negotiated.platformRevenuePesewas).toBe(2_500);
  });

  it('falls back to the model defaults when no rates are supplied', () => {
    const fallback = PayoutCalculator.calculate(100_000, 'bnpl', 'order_approved')!;
    expect(fallback.mdrPesewas).toBe(4_000);
    expect(fallback.reservePesewas).toBe(5_000);
    expect(fallback.netPesewas).toBe(91_000);
  });

  it('applies plan rates to a partial split, not just the whole order', () => {
    // hybrid pays 40% at the down payment; the rate applies to that slice.
    const b = PayoutCalculator.calculate(100_000, 'hybrid', 'down_payment_received', {
      rates: { mdrBps: 250, reserveBps: 100 },
    })!;
    expect(b.grossPesewas).toBe(40_000);
    expect(b.mdrPesewas).toBe(1_000); // 2.5% of 40,000
    expect(b.reservePesewas).toBe(400); // 1% of 40,000
    expect(b.netPesewas).toBe(38_600);
  });
});

describe.skipIf(!RUN_DB)('Settlement terms (integration)', () => {
  const { db, pool } = createDb({ connectionString: process.env.DATABASE_URL! });
  const audit = new AuditLogger();
  const ledger = new LedgerService(db);
  const payouts = new PayoutRecorder(db, ledger);
  const merchants = new MerchantsService(db, audit);
  const ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  afterAll(async () => {
    await pool.end();
  });

  function transfers(status = 'success'): PayoutTransferClient & { calls: number } {
    const state = {
      calls: 0,
      async initiateTransfer(req: { reference: string }) {
        state.calls += 1;
        return { data: { transfer_code: `TRF_${state.calls}`, reference: req.reference, status } };
      },
    };
    return state as PayoutTransferClient & { calls: number };
  }

  async function activeMerchant(opts: { minPayout?: number } = {}): Promise<string> {
    const s = randomUUID();
    const m = await merchants.create(
      {
        business_name: `T ${s}`,
        legal_name: `T Ltd ${s}`,
        email: `t+${s}@x.gh`,
        phone: `+2332${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
      },
      ACTOR,
    );
    await db
      .update(schema.merchants)
      .set({
        status: 'active',
        paystack_recipient_code: `RCP_${s}`,
        ...(opts.minPayout !== undefined ? { min_payout_pesewas: opts.minPayout } : {}),
      })
      .where(eq(schema.merchants.id, m.id));
    return m.id;
  }

  /** Seeds a merchant_payable balance via a balanced transaction. */
  async function owe(merchantId: string, amount: number) {
    const transactionId = `seed:${merchantId}:${randomUUID()}`;
    await ledger.record([
      {
        transactionId,
        accountType: 'receivable',
        accountRef: merchantId,
        direction: 'debit',
        amountPesewas: amount,
        description: 'seed',
      },
      {
        transactionId,
        accountType: 'merchant_payable',
        accountRef: merchantId,
        direction: 'credit',
        amountPesewas: amount,
        description: 'seed',
      },
    ]);
  }

  it('leaves the model rate in place when a merchant has no negotiated override', async () => {
    // The regression this guards: `merchants.default_reserve_bps` is NOT NULL
    // DEFAULT 500, so honouring it directly would push every layaway plan from
    // the model's risk-based 2% to 5% for merchants who never negotiated
    // anything. NULL override must mean "use the model rate".
    const merchantId = await activeMerchant();
    const row = (
      await db
        .select({
          mdrOverride: schema.merchants.mdr_bps_override,
          reserveOverride: schema.merchants.reserve_bps_override,
        })
        .from(schema.merchants)
        .where(eq(schema.merchants.id, merchantId))
    )[0]!;
    expect(row.mdrOverride).toBeNull();
    expect(row.reserveOverride).toBeNull();

    const layaway = PayoutCalculator.calculate(100_000, 'layaway', 'plan_completed', {
      rates: { mdrBps: undefined, reserveBps: undefined },
    })!;
    expect(layaway.mdrPesewas).toBe(3_000); // 3%, layaway's own rate
    expect(layaway.reservePesewas).toBe(2_000); // 2%, not the merchant column's 5%
  });

  it('books an accrual at the plan rate, not the model default', async () => {
    const merchantId = await activeMerchant();
    const planId = randomUUID();

    const breakdown = await payouts.recordPayoutAccrual({
      customerPlanId: planId,
      merchantId,
      orderAmountPesewas: 100_000,
      model: 'bnpl',
      trigger: 'order_approved',
      mdrBps: 250,
      reserveBps: 0,
    });

    expect(breakdown!.mdrPesewas).toBe(2_500);
    // The merchant keeps what was negotiated: 100,000 - 2,500 - 0.
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(97_500);
    expect(await ledger.balanceOf('reserve_held', planId)).toBe(0);
  });

  it('reverses a refund at the same rate the accrual used', async () => {
    const merchantId = await activeMerchant();
    const planId = randomUUID();
    await payouts.recordPayoutAccrual({
      customerPlanId: planId,
      merchantId,
      orderAmountPesewas: 100_000,
      model: 'bnpl',
      trigger: 'order_approved',
      mdrBps: 250,
      reserveBps: 0,
    });

    // Refund a quarter of the order.
    await payouts.reverseAccrualsForRefund({
      customerPlanId: planId,
      scheduleId: randomUUID(),
      refundAmountPesewas: 25_000,
      model: 'bnpl',
      mdrBps: 250,
      reserveBps: 0,
    });

    // Clawed back at 2.5%, matching the forward split — 97,500 - 24,375.
    // Reversing at the 4% default would have taken a different amount than was
    // ever credited, leaving a permanent discrepancy.
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(97_500 - 24_375);
  });

  it('rolls a balance below the merchant floor forward instead of transferring', async () => {
    const merchantId = await activeMerchant({ minPayout: 10_000 });
    await owe(merchantId, 500); // GHS 5 — a transfer fee could exceed it
    const client = transfers();

    const result = await new SettlementService(db, ledger, audit, client).settleMerchant(
      merchantId,
      new Date('2026-09-01'),
    );

    expect(result.status).toBe('skipped');
    expect(result.reason).toMatch(/below minimum payout/);
    expect(client.calls).toBe(0);
    // Still owed — it rolls forward to a later run rather than being lost.
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(500);
  });

  it('pays out once the balance reaches the floor', async () => {
    const merchantId = await activeMerchant({ minPayout: 10_000 });
    await owe(merchantId, 10_000);
    const client = transfers();

    const result = await new SettlementService(db, ledger, audit, client).settleMerchant(
      merchantId,
      new Date('2026-09-02'),
    );
    expect(result.status).toBe('settled');
    expect(client.calls).toBe(1);
  });

  it('honours a zero floor for a merchant who wants every cedi', async () => {
    const merchantId = await activeMerchant({ minPayout: 0 });
    await owe(merchantId, 50);
    const client = transfers();

    const result = await new SettlementService(db, ledger, audit, client).settleMerchant(
      merchantId,
      new Date('2026-09-03'),
    );
    expect(result.status).toBe('settled');
  });

  it('retries the same day after a failed transfer', async () => {
    const merchantId = await activeMerchant({ minPayout: 0 });
    await owe(merchantId, 20_000);
    const asOf = new Date('2026-09-04');

    const failing = transfers('failed');
    const first = await new SettlementService(db, ledger, audit, failing).settleMerchant(
      merchantId,
      asOf,
    );
    expect(first.status).toBe('failed');
    // The reversal restored what we owe.
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(20_000);

    // Before S8 this returned "already settled today" and stranded the merchant
    // until the next calendar day, for a transfer that never happened.
    const succeeding = transfers('success');
    const second = await new SettlementService(db, ledger, audit, succeeding).settleMerchant(
      merchantId,
      asOf,
    );
    expect(second.status).toBe('settled');
    expect(succeeding.calls).toBe(1);
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(0);

    // One payout row per merchant per day is still the invariant.
    const rows = await db
      .select()
      .from(schema.payouts)
      .where(eq(schema.payouts.merchant_id, merchantId));
    expect(rows).toHaveLength(1);
    // ...and the retry used a fresh provider reference, since Paystack treats a
    // repeated reference as the same transaction.
    expect(rows[0]!.reference).toMatch(/:r\d+$/);
  });

  it('still blocks a re-run of a successful payout', async () => {
    const merchantId = await activeMerchant({ minPayout: 0 });
    await owe(merchantId, 30_000);
    const asOf = new Date('2026-09-05');
    const client = transfers('success');
    const settlement = new SettlementService(db, ledger, audit, client);

    await settlement.settleMerchant(merchantId, asOf);
    const again = await settlement.settleMerchant(merchantId, asOf);

    expect(again.reason).toBe('already settled today');
    expect(client.calls).toBe(1);
  });
});
