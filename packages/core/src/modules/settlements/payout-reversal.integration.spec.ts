import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, schema } from '@installment/db';
import { AuditLogger } from '../audit/audit-logger.service';
import { SYSTEM_ACTORS } from '../../shared/constants/system-actors';
import { MerchantsService } from '../merchants/merchants.service';
import { LedgerService } from '../../shared/ledger/ledger.service';
import { RedisLock } from '../../shared/lock/redis-lock';
import { EventBus } from '../../shared/event-bus/event-bus';
import { CustomerPlansService } from '../schedules/customer-plans.service';
import { ScheduleStateService } from '../schedules/schedule-state.service';
import { AttemptRepository } from '../payments/attempt-repository';
import { WebhookService } from '../webhooks/webhook.service';
import { SettlementService, type PayoutTransferClient } from './settlement.service';

const RUN_DB = Boolean(process.env.DATABASE_URL);
const ALWAYS_OPEN = { set: async () => 'OK' as const, eval: async () => 1 };
const ACCEPT = { verifySignature: () => true };

/** A transfer client Paystack-style: accepts and reports success at once. */
const succeeding: PayoutTransferClient = {
  async initiateTransfer(req) {
    return {
      data: { transfer_code: `TRF_${req.reference}`, reference: req.reference, status: 'success' },
    };
  },
};

/**
 * A payout Paystack sends back after it has gone out.
 *
 * Paystack reverses GHS transfers days later when the recipient bank or wallet
 * rejects them, and says so with `transfer.reversed`. The webhook's own comment
 * describes the stakes — the merchant recorded as paid while holding nothing —
 * and maps the event to `confirmPayout(…, 'failed')`. But `confirmPayout`
 * returns early for a payout already `settled`, and a reversal days later
 * arrives exactly then. So it was a silent no-op: the payout stayed `settled`,
 * `merchant_payable` stayed cleared, and the `reversed` status — declared,
 * read in five places — was written by nothing. There was no test for
 * `transfer.reversed` at all.
 */
describe.skipIf(!RUN_DB)('a payout reversed after it settled (integration)', () => {
  const { db, pool } = createTestDb();
  const audit = new AuditLogger();
  const ledger = new LedgerService(db);
  const merchants = new MerchantsService(db, audit);
  const plans = new CustomerPlansService(db, audit);
  const scheduleState = new ScheduleStateService(
    db,
    audit,
    new RedisLock(ALWAYS_OPEN),
    new EventBus(),
  );
  const attempts = new AttemptRepository(db);
  const ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  afterAll(async () => {
    await pool.end();
  });

  async function merchantOwed(amountPesewas: number): Promise<string> {
    const suffix = randomUUID();
    const merchant = await merchants.create(
      {
        business_name: `Rev ${suffix}`,
        legal_name: `Rev Ltd ${suffix}`,
        email: `rev+${suffix}@x.gh`,
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

  async function payout(reference: string) {
    return (
      await db.select().from(schema.payouts).where(eq(schema.payouts.reference, reference))
    )[0]!;
  }

  async function settledPayout(amount: number, day: string) {
    const merchantId = await merchantOwed(amount);
    const settlement = new SettlementService(db, ledger, audit, succeeding);
    const result = await settlement.settleMerchant(merchantId, new Date(day));
    expect(result.status).toBe('settled');
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(0);
    return { merchantId, settlement, reference: result.reference! };
  }

  function webhooksWith(settlement: SettlementService) {
    return new WebhookService(
      db,
      ACCEPT,
      attempts,
      plans,
      scheduleState,
      undefined,
      undefined,
      settlement,
    );
  }

  it('restores what the merchant is owed when a settled payout is reversed', async () => {
    const { merchantId, settlement, reference } = await settledPayout(40_000, '2026-09-01');

    await settlement.confirmPayout(reference, 'reversed', { error: 'Recipient account rejected' });

    const p = await payout(reference);
    expect(p.status).toBe('reversed');
    expect(p.last_error).toBe('Recipient account rejected');
    // The money came back to Ejua; the merchant is owed it again.
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(40_000);
  });

  it("applies Paystack's transfer.reversed webhook to a settled payout", async () => {
    const { merchantId, settlement, reference } = await settledPayout(25_000, '2026-09-02');
    const webhooks = webhooksWith(settlement);

    const raw = JSON.stringify({
      event: 'transfer.reversed',
      data: { reference, status: 'reversed', amount: 25_000, gateway_response: 'Account rejected' },
    });
    const result = await webhooks.ingest(raw, 'sig');

    expect(result.processed).toBe(true);
    expect((await payout(reference)).status).toBe('reversed');
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(25_000);
  });

  it('reverses a payout once, however often it is told', async () => {
    const { merchantId, settlement, reference } = await settledPayout(30_000, '2026-09-03');
    await settlement.confirmPayout(reference, 'reversed');
    await settlement.confirmPayout(reference, 'reversed');
    // Credited once, not twice: an append-only book cannot take it back.
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(30_000);
  });

  it('pays the restored balance on the next run', async () => {
    const { merchantId, settlement, reference } = await settledPayout(20_000, '2026-09-04');
    await settlement.confirmPayout(reference, 'reversed');

    const again = await settlement.settleMerchant(merchantId, new Date('2026-09-05'));
    expect(again.status).toBe('settled');
    expect(again.amountPesewas).toBe(20_000);
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(0);
  });

  it('still ignores a failure reported for a payout that settled', async () => {
    // `transfer.failed` after `transfer.success` is not a thing Paystack
    // sends; a reversal is. Treating a stray failure as one would credit the
    // merchant for money they actually received.
    const { merchantId, settlement, reference } = await settledPayout(15_000, '2026-09-06');
    await settlement.confirmPayout(reference, 'failed');
    expect((await payout(reference)).status).toBe('settled');
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(0);
  });
});
