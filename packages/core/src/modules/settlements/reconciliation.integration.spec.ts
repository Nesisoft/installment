import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, schema } from '@installment/db';
import { AuditLogger } from '../audit/audit-logger.service';
import { SYSTEM_ACTORS } from '../../shared/constants/system-actors';
import { MerchantsService } from '../merchants/merchants.service';
import { LedgerService } from '../../shared/ledger/ledger.service';
import { SettlementService, type PayoutTransferClient } from './settlement.service';
import { ReconciliationService, type TransferVerifyClient } from './reconciliation.service';

const RUN_DB = Boolean(process.env.DATABASE_URL);

/** Transfer client returning a fixed initiate status. */
function transfers(status: string): PayoutTransferClient {
  return {
    async initiateTransfer(req) {
      return { data: { transfer_code: `TRF_${req.reference}`, reference: req.reference, status } };
    },
  };
}

/** Transfer client whose initiate always throws (drives a payout to `unknown`). */
const throwingTransfers: PayoutTransferClient = {
  async initiateTransfer() {
    throw new Error('network timeout');
  },
};

/** Verify client scripted by reference → status, or throwing a {status} error. */
function verifier(script: Record<string, string | { throwStatus: number }>): TransferVerifyClient {
  return {
    async verifyTransfer(reference) {
      const entry = script[reference];
      if (entry === undefined) {
        const err = Object.assign(new Error('not found'), { status: 404 });
        throw err;
      }
      if (typeof entry === 'object') {
        const err = Object.assign(new Error(`http ${entry.throwStatus}`), {
          status: entry.throwStatus,
        });
        throw err;
      }
      return { data: { status: entry, transfer_code: `TRF_${reference}` } };
    },
  };
}

describe.skipIf(!RUN_DB)('ReconciliationService (integration)', () => {
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
        business_name: `M ${suffix}`,
        legal_name: `M Ltd ${suffix}`,
        email: `m+${suffix}@x.gh`,
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

  async function loadPayout(reference: string) {
    return (
      await db.select().from(schema.payouts).where(eq(schema.payouts.reference, reference))
    )[0];
  }

  it('settles a pending payout once Paystack confirms success', async () => {
    const merchantId = await merchantOwed(50_000);
    const settlement = new SettlementService(db, ledger, audit, transfers('pending'));
    const pending = await settlement.settleMerchant(merchantId, new Date('2026-08-01'));
    expect(pending.status).toBe('pending_confirmation');

    const recon = new ReconciliationService(
      db,
      settlement,
      verifier({ [pending.reference!]: 'success' }),
    );
    const summary = await recon.reconcilePendingPayouts();

    const result = summary.results.find((r) => r.reference === pending.reference);
    expect(result?.outcome).toBe('settled');
    expect((await loadPayout(pending.reference!))!.status).toBe('settled');
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(0); // stayed debited
  });

  it('fails + reverses a pending payout when Paystack reports failure', async () => {
    const merchantId = await merchantOwed(40_000);
    const settlement = new SettlementService(db, ledger, audit, transfers('pending'));
    const pending = await settlement.settleMerchant(merchantId, new Date('2026-08-02'));
    expect(pending.status).toBe('pending_confirmation');

    const recon = new ReconciliationService(
      db,
      settlement,
      verifier({ [pending.reference!]: 'failed' }),
    );
    await recon.reconcilePendingPayouts();

    expect((await loadPayout(pending.reference!))!.status).toBe('failed');
    // Reversal restored the payable.
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(40_000);
  });

  it('leaves a still-pending payout untouched for the next sweep', async () => {
    const merchantId = await merchantOwed(25_000);
    const settlement = new SettlementService(db, ledger, audit, transfers('pending'));
    const pending = await settlement.settleMerchant(merchantId, new Date('2026-08-03'));

    const recon = new ReconciliationService(
      db,
      settlement,
      verifier({ [pending.reference!]: 'pending' }),
    );
    const summary = await recon.reconcilePendingPayouts();

    const result = summary.results.find((r) => r.reference === pending.reference);
    expect(result?.outcome).toBe('still_pending');
    expect((await loadPayout(pending.reference!))!.status).toBe('pending_confirmation');
  });

  it('reverses an unknown payout when verify 404s (transfer never created)', async () => {
    const merchantId = await merchantOwed(30_000);
    const settlement = new SettlementService(db, ledger, audit, throwingTransfers);
    const unknown = await settlement.settleMerchant(merchantId, new Date('2026-08-04'));
    expect(unknown.status).toBe('unknown');
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(0); // debited, not reversed

    // Empty script → verify throws 404 for this reference.
    const recon = new ReconciliationService(db, settlement, verifier({}));
    const summary = await recon.reconcilePendingPayouts();

    const result = summary.results.find((r) => r.reference === unknown.reference);
    expect(result?.outcome).toBe('failed');
    expect((await loadPayout(unknown.reference!))!.status).toBe('failed');
    // Payable restored — the transfer never happened.
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(30_000);
  });

  it('promotes an unknown payout to settled when verify finds it succeeded', async () => {
    const merchantId = await merchantOwed(18_000);
    const settlement = new SettlementService(db, ledger, audit, throwingTransfers);
    const unknown = await settlement.settleMerchant(merchantId, new Date('2026-08-05'));
    expect(unknown.status).toBe('unknown');

    const recon = new ReconciliationService(
      db,
      settlement,
      verifier({ [unknown.reference!]: 'success' }),
    );
    await recon.reconcilePendingPayouts();

    expect((await loadPayout(unknown.reference!))!.status).toBe('settled');
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(0); // stays debited
  });

  it('leaves a payout unresolved on a transient verify error (no auto-reverse)', async () => {
    const merchantId = await merchantOwed(22_000);
    const settlement = new SettlementService(db, ledger, audit, throwingTransfers);
    const unknown = await settlement.settleMerchant(merchantId, new Date('2026-08-06'));

    // 500 from verify — transient, must not reverse.
    const recon = new ReconciliationService(
      db,
      settlement,
      verifier({ [unknown.reference!]: { throwStatus: 500 } }),
    );
    const summary = await recon.reconcilePendingPayouts();

    const result = summary.results.find((r) => r.reference === unknown.reference);
    expect(result?.outcome).toBe('unresolved');
    expect((await loadPayout(unknown.reference!))!.status).toBe('unknown'); // unchanged
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(0); // not restored
  });
});
