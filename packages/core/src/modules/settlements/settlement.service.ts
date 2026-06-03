import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import { AuditLogger } from '../audit/audit-logger.service';
import { LedgerService } from '../../shared/ledger/ledger.service';
import { runInTransaction } from '../../shared/event-bus/transaction';
import { SYSTEM_ACTORS } from '../../shared/constants/system-actors';

const payouts = schema.payouts;
const ledger = schema.ledger_entries;
const merchants = schema.merchants;

/** The single platform cash account that funds merchant transfers. */
export const SETTLEMENT_CASH_REF = 'main';

const SETTLEMENT_ACTOR = {
  actorId: SYSTEM_ACTORS.SETTLEMENT_WORKER,
  actorType: 'system' as const,
};

/** The slice of the Paystack client the settlement worker needs. */
export interface PayoutTransferClient {
  initiateTransfer(req: {
    source: 'balance';
    /** Amount in pesewas (integer). */
    amount: number;
    /** Merchant's Paystack recipient code. */
    recipient: string;
    reason: string;
    reference: string;
  }): Promise<{ data: { transfer_code: string; reference: string; status: string } }>;
}

export type PayoutStatus =
  | 'initiated'
  | 'pending_confirmation'
  | 'settled'
  | 'failed'
  | 'unknown'
  | 'reversed';

export interface SettlementResult {
  merchantId: string;
  status: PayoutStatus | 'skipped';
  amountPesewas: number;
  payoutId?: string;
  reference?: string;
  /** Why a merchant was skipped, or the transfer error. */
  reason?: string;
}

export interface DailySettlementSummary {
  asOfDate: string;
  results: SettlementResult[];
  totalSettledPesewas: number;
}

export class PayoutNotFoundError extends Error {
  constructor(reference: string) {
    super(`Payout "${reference}" not found`);
    this.name = 'PayoutNotFoundError';
  }
}

/**
 * Daily merchant settlement (ported from docs/design/settlement-engine.ts).
 *
 * For each merchant we owe (a positive `merchant_payable` ledger balance), the
 * worker books the payout liability down and initiates a Paystack transfer:
 *
 *   DEBIT  merchant_payable[merchant]   amount   (clear what we owe)
 *   CREDIT paystack_settlement[main]    amount   (cash leaves our balance)
 *
 * The ledger debit + the `payouts` row commit together BEFORE the transfer, so
 * a crash can never double-pay (the balance is already cleared). A definitively
 * rejected transfer is reversed; a transfer that errors mid-flight is left in
 * `unknown` for the reconciliation worker to resolve via verifyTransfer.
 *
 * Idempotency is anchored on the `payouts` UNIQUE(merchant_id, as_of_date) — at
 * most one payout per merchant per day; a re-run returns the existing row.
 */
export class SettlementService {
  constructor(
    private readonly db: Database,
    private readonly ledger: LedgerService,
    private readonly audit: AuditLogger,
    private readonly transfers: PayoutTransferClient,
  ) {}

  /** Settles every merchant we owe as of `asOf`. */
  async runDailySettlement(asOf: Date = new Date()): Promise<DailySettlementSummary> {
    const owed = await this.db
      .selectDistinct({ merchantId: ledger.account_ref })
      .from(ledger)
      .where(eq(ledger.account_type, 'merchant_payable'));

    const results: SettlementResult[] = [];
    let totalSettled = 0;
    for (const { merchantId } of owed) {
      const result = await this.settleMerchant(merchantId, asOf);
      results.push(result);
      if (result.status === 'settled') totalSettled += result.amountPesewas;
    }

    return { asOfDate: isoDate(asOf), results, totalSettledPesewas: totalSettled };
  }

  /**
   * Settles one merchant for the day: books the liability down, creates the
   * payout row, and initiates the transfer. Safe to call repeatedly — the
   * day's payout is created at most once.
   */
  async settleMerchant(merchantId: string, asOf: Date = new Date()): Promise<SettlementResult> {
    const asOfDate = isoDate(asOf);

    const balance = await this.ledger.balanceOf('merchant_payable', merchantId);
    if (balance <= 0) {
      return { merchantId, status: 'skipped', amountPesewas: 0, reason: 'no balance owed' };
    }

    const merchant = (
      await this.db
        .select({ status: merchants.status, recipient: merchants.paystack_recipient_code })
        .from(merchants)
        .where(eq(merchants.id, merchantId))
        .limit(1)
    )[0];
    if (!merchant || merchant.status !== 'active') {
      return {
        merchantId,
        status: 'skipped',
        amountPesewas: balance,
        reason: 'merchant not active',
      };
    }
    if (!merchant.recipient) {
      return {
        merchantId,
        status: 'skipped',
        amountPesewas: balance,
        reason: 'no Paystack recipient code',
      };
    }

    // Already handled today? UNIQUE(merchant_id, as_of_date) makes this the
    // idempotency anchor — return the existing row's outcome rather than re-pay.
    const existing = (
      await this.db
        .select()
        .from(payouts)
        .where(and(eq(payouts.merchant_id, merchantId), eq(payouts.as_of_date, asOfDate)))
        .limit(1)
    )[0];
    if (existing) {
      return {
        merchantId,
        status: existing.status as PayoutStatus,
        amountPesewas: existing.amount_pesewas,
        payoutId: existing.id,
        reference: existing.reference,
        reason: 'already settled today',
      };
    }

    const reference = `payout:${merchantId}:${asOfDate}`;

    // Book the liability down + create the payout row atomically, BEFORE the
    // transfer, so we can never double-pay.
    const payoutId = await runInTransaction(this.db, async (tx) => {
      const [row] = await tx
        .insert(payouts)
        .values({
          merchant_id: merchantId,
          amount_pesewas: balance,
          as_of_date: asOfDate,
          reference,
          status: 'initiated',
        })
        .returning();
      if (!row) throw new Error('payouts insert returned no row');

      await this.ledger.record(
        [
          {
            transactionId: `payout:${row.id}`,
            accountType: 'merchant_payable',
            accountRef: merchantId,
            direction: 'debit',
            amountPesewas: balance,
            description: `Settlement payout ${asOfDate}`,
            metadata: { payout_id: row.id, as_of_date: asOfDate },
          },
          {
            transactionId: `payout:${row.id}`,
            accountType: 'paystack_settlement',
            accountRef: SETTLEMENT_CASH_REF,
            direction: 'credit',
            amountPesewas: balance,
            description: `Cash out for payout ${row.id}`,
            metadata: { payout_id: row.id, merchant_id: merchantId },
          },
        ],
        tx,
      );

      await this.audit.append(tx, {
        entityType: 'payout',
        entityId: row.id,
        eventType: 'payout.initiated',
        toState: 'initiated',
        actorId: SETTLEMENT_ACTOR.actorId,
        actorType: SETTLEMENT_ACTOR.actorType,
        metadata: { merchant_id: merchantId, amount_pesewas: balance, as_of_date: asOfDate },
      });
      return row.id;
    });

    // Initiate the transfer. The liability is already cleared, so failures only
    // need to either reverse (definitive rejection) or park as unknown.
    try {
      const res = await this.transfers.initiateTransfer({
        source: 'balance',
        amount: balance,
        recipient: merchant.recipient,
        reason: `Settlement for ${asOfDate}`,
        reference,
      });
      const status = (res.data.status ?? '').toLowerCase();

      if (status === 'success') {
        await this.markTerminal(payoutId, 'settled', { transferCode: res.data.transfer_code });
        return { merchantId, status: 'settled', amountPesewas: balance, payoutId, reference };
      }
      if (status === 'failed' || status === 'reversed') {
        await this.reverseAndFail(payoutId, merchantId, balance, `transfer ${status}`);
        return {
          merchantId,
          status: 'failed',
          amountPesewas: balance,
          payoutId,
          reference,
          reason: `transfer ${status}`,
        };
      }
      // pending / otp / anything else → awaiting async confirmation.
      await this.markPending(payoutId, res.data.transfer_code);
      return {
        merchantId,
        status: 'pending_confirmation',
        amountPesewas: balance,
        payoutId,
        reference,
      };
    } catch (err) {
      // Mid-flight error: we don't know if Paystack accepted it. Park as
      // `unknown` (ledger stays debited) for reconciliation to resolve — never
      // auto-reverse here, that risks a double payout.
      const message = err instanceof Error ? err.message : String(err);
      await this.markUnknown(payoutId, message);
      return {
        merchantId,
        status: 'unknown',
        amountPesewas: balance,
        payoutId,
        reference,
        reason: message,
      };
    }
  }

  /**
   * Async confirmation hook for the transfer webhook / reconciliation poller.
   * Settles or reverses a payout that was left pending/unknown. Idempotent —
   * a payout already in a terminal state is left untouched.
   */
  async confirmPayout(
    reference: string,
    outcome: 'settled' | 'failed',
    opts: { transferId?: string; error?: string } = {},
  ): Promise<void> {
    const payout = (
      await this.db.select().from(payouts).where(eq(payouts.reference, reference)).limit(1)
    )[0];
    if (!payout) throw new PayoutNotFoundError(reference);
    if (payout.status === 'settled' || payout.status === 'failed' || payout.status === 'reversed') {
      return; // terminal — idempotent no-op
    }

    if (outcome === 'settled') {
      await this.markTerminal(payout.id, 'settled', { transferId: opts.transferId });
    } else {
      await this.reverseAndFail(
        payout.id,
        payout.merchant_id,
        payout.amount_pesewas,
        opts.error ?? 'transfer failed',
      );
    }
  }

  /** Marks a payout settled (no ledger change — the debit happened at initiation). */
  private async markTerminal(
    payoutId: string,
    status: 'settled',
    opts: { transferCode?: string; transferId?: string },
  ): Promise<void> {
    const nowIso = new Date().toISOString();
    await runInTransaction(this.db, async (tx) => {
      await tx
        .update(payouts)
        .set({
          status,
          settled_at: nowIso,
          ...(opts.transferCode ? { paystack_transfer_code: opts.transferCode } : {}),
          ...(opts.transferId ? { paystack_transfer_id: opts.transferId } : {}),
        })
        .where(eq(payouts.id, payoutId));
      await this.audit.append(tx, {
        entityType: 'payout',
        entityId: payoutId,
        eventType: 'payout.settled',
        fromState: 'initiated',
        toState: 'settled',
        actorId: SETTLEMENT_ACTOR.actorId,
        actorType: SETTLEMENT_ACTOR.actorType,
      });
    });
  }

  private async markPending(payoutId: string, transferCode: string): Promise<void> {
    await runInTransaction(this.db, async (tx) => {
      await tx
        .update(payouts)
        .set({ status: 'pending_confirmation', paystack_transfer_code: transferCode })
        .where(eq(payouts.id, payoutId));
      await this.audit.append(tx, {
        entityType: 'payout',
        entityId: payoutId,
        eventType: 'payout.pending_confirmation',
        fromState: 'initiated',
        toState: 'pending_confirmation',
        actorId: SETTLEMENT_ACTOR.actorId,
        actorType: SETTLEMENT_ACTOR.actorType,
      });
    });
  }

  private async markUnknown(payoutId: string, error: string): Promise<void> {
    await runInTransaction(this.db, async (tx) => {
      await tx
        .update(payouts)
        .set({ status: 'unknown', last_error: error })
        .where(eq(payouts.id, payoutId));
      await this.audit.append(tx, {
        entityType: 'payout',
        entityId: payoutId,
        eventType: 'payout.unknown',
        fromState: 'initiated',
        toState: 'unknown',
        actorId: SETTLEMENT_ACTOR.actorId,
        actorType: SETTLEMENT_ACTOR.actorType,
        reason: error,
      });
    });
  }

  /** Reverses the payout's ledger debit and marks it failed — restores the liability. */
  private async reverseAndFail(
    payoutId: string,
    merchantId: string,
    amountPesewas: number,
    reason: string,
  ): Promise<void> {
    const nowIso = new Date().toISOString();
    await runInTransaction(this.db, async (tx) => {
      await this.ledger.record(
        [
          {
            transactionId: `payout-reversal:${payoutId}`,
            accountType: 'paystack_settlement',
            accountRef: SETTLEMENT_CASH_REF,
            direction: 'debit',
            amountPesewas,
            description: `Reverse cash-out for failed payout ${payoutId}`,
            metadata: { payout_id: payoutId },
          },
          {
            transactionId: `payout-reversal:${payoutId}`,
            accountType: 'merchant_payable',
            accountRef: merchantId,
            direction: 'credit',
            amountPesewas,
            description: `Restore payable for failed payout ${payoutId}`,
            metadata: { payout_id: payoutId },
          },
        ],
        tx,
      );
      await tx
        .update(payouts)
        .set({ status: 'failed', failed_at: nowIso, last_error: reason })
        .where(eq(payouts.id, payoutId));
      await this.audit.append(tx, {
        entityType: 'payout',
        entityId: payoutId,
        eventType: 'payout.failed',
        toState: 'failed',
        actorId: SETTLEMENT_ACTOR.actorId,
        actorType: SETTLEMENT_ACTOR.actorType,
        reason,
      });
    });
  }
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
