import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, schema } from '@installment/db';
import { AuditLogger } from '../audit/audit-logger.service';
import { SYSTEM_ACTORS } from '../../shared/constants/system-actors';
import { MerchantsService } from '../merchants/merchants.service';
import { LedgerService } from '../../shared/ledger/ledger.service';
import { SettlementService, type PayoutTransferClient } from './settlement.service';
import { ReconciliationService, type TransferVerifyClient } from './reconciliation.service';

const RUN_DB = Boolean(process.env.DATABASE_URL);

/** Leaves every payout in `pending_confirmation`, ready to reconcile. */
const pendingTransfers: PayoutTransferClient = {
  async initiateTransfer(req) {
    return {
      data: { transfer_code: `TRF_${req.reference}`, reference: req.reference, status: 'pending' },
    };
  },
};

/** Reports every transfer as succeeded, so each row wants `confirmPayout`. */
const successVerifier: TransferVerifyClient = {
  async verifyTransfer(reference) {
    return { data: { status: 'success', transfer_code: `TRF_${reference}` } };
  },
};

/**
 * `reconcileOne` says "Never throws — verify errors become `unresolved`". That
 * holds for the *verify* call, which is wrapped. Every `confirmPayout` is
 * outside the try, and it can throw: it opens a transaction and takes a
 * FOR UPDATE lock, so a lock timeout or a serialization failure surfaces here,
 * and a missing row raises PayoutNotFoundError. Neither sweep loop caught, so
 * one such row ended reconciliation for every row behind it — money left
 * in-flight with no second attempt until a human noticed.
 */
describe.skipIf(!RUN_DB)('reconciliation resilience (integration)', () => {
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
        business_name: `MR ${suffix}`,
        legal_name: `MR Ltd ${suffix}`,
        email: `mr+${suffix}@x.gh`,
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

  it('keeps reconciling after one payout throws, and reports it unresolved', async () => {
    const settlement = new SettlementService(db, ledger, audit, pendingTransfers);
    const reconciler = new ReconciliationService(db, settlement, successVerifier);

    // Two payouts left pending, on different merchants so both are picked up.
    const a = await merchantOwed(40_000);
    const b = await merchantOwed(60_000);
    const pa = await settlement.settleMerchant(a);
    const pb = await settlement.settleMerchant(b);
    expect(pa.status).toBe('pending_confirmation');
    expect(pb.status).toBe('pending_confirmation');
    // A pending payout always carries its provider reference; narrow it once.
    expect(pa.reference).toBeDefined();
    expect(pb.reference).toBeDefined();
    const refA = pa.reference!;
    const refB = pb.reference!;

    const refs = new Set([refA, refB]);
    const real = settlement.confirmPayout.bind(settlement);
    const spy = vi
      .spyOn(settlement, 'confirmPayout')
      .mockImplementation(async (reference, outcome, opts) => {
        if (reference === refA) throw new Error('lock timeout on payouts row');
        return real(reference, outcome, opts);
      });

    let summary;
    try {
      summary = await reconciler.reconcilePendingPayouts({ limit: 500 });
    } finally {
      spy.mockRestore();
    }

    const ours = summary.results.filter((r) => refs.has(r.reference));
    expect(ours).toHaveLength(2);

    // The throwing row is reported, not swallowed and not fatal.
    const failed = ours.find((r) => r.reference === refA)!;
    expect(failed.outcome).toBe('unresolved');
    expect(failed.reason).toContain('lock timeout');

    // The row behind it was still reconciled.
    const ok = ours.find((r) => r.reference === refB)!;
    expect(ok.outcome).toBe('settled');

    const [rowB] = await db.select().from(schema.payouts).where(eq(schema.payouts.reference, refB));
    expect(rowB!.status).toBe('settled');

    // And the one that threw is untouched, so the next sweep retries it.
    const [rowA] = await db.select().from(schema.payouts).where(eq(schema.payouts.reference, refA));
    expect(rowA!.status).toBe('pending_confirmation');
  });
});
