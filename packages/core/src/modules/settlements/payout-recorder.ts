import { eq, like } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import { Money } from '../../shared/money/money';
import { LedgerService, type LedgerExecutor } from '../../shared/ledger/ledger.service';
import { PayoutCalculator, type PayoutBreakdown } from './payout-calculator';
import { MODEL_CONFIG, type BusinessModel, type PayoutTrigger } from './model-config';

const ledger = schema.ledger_entries;

/** Single ledger account that holds platform revenue across all plans. */
export const PLATFORM_ACCOUNT_REF = 'platform';

export interface RecordPayoutAccrualInput {
  customerPlanId: string;
  merchantId: string;
  orderAmountPesewas: number;
  model: BusinessModel;
  trigger: PayoutTrigger;
  /** Required when `trigger` is `installment_n`. */
  installmentNumber?: number;
}

export interface ReverseAccrualsForRefundInput {
  customerPlanId: string;
  /** The refunded installment — used in the reversal transactionId for idempotency. */
  scheduleId: string;
  /** The amount returning to the customer; scales the proportional clawback. */
  refundAmountPesewas: number;
  model: BusinessModel;
}

export interface RefundReversalSummary {
  totalReversedGrossPesewas: number;
  /** One entry per accrual transaction that was reversed (or replayed idempotently). */
  reversals: Array<{
    accrualTransactionId: string;
    refundTransactionId: string;
    grossPesewas: number;
    netPesewas: number;
    mdrPesewas: number;
    reservePesewas: number;
  }>;
}

/**
 * Books the merchant payout accrual for one payout trigger as a balanced
 * double-entry transaction (ported from docs/design/settlement-engine.ts):
 *
 *   DEBIT  receivable[plan]        gross
 *   CREDIT merchant_payable[merchant] net
 *   CREDIT revenue[platform]       mdr
 *   CREDIT reserve_held[plan]      reserve
 *
 * The transactionId is deterministic — `accrue:{plan}:{trigger}[:n]` — so a
 * replay returns the same breakdown without inserting duplicate rows.
 * No actual money moves; the settlement worker pays merchants from
 * `merchant_payable` balances later.
 */
export class PayoutRecorder {
  constructor(
    private readonly db: Database,
    private readonly ledger: LedgerService,
  ) {}

  async recordPayoutAccrual(
    input: RecordPayoutAccrualInput,
    tx?: LedgerExecutor,
  ): Promise<PayoutBreakdown | null> {
    const breakdown = PayoutCalculator.calculate(
      input.orderAmountPesewas,
      input.model,
      input.trigger,
      { installmentNumber: input.installmentNumber },
    );
    if (!breakdown || breakdown.grossPesewas === 0) return null;

    const transactionId = this.buildTransactionId(input);
    const exec: LedgerExecutor = tx ?? this.db;

    // Idempotency: a replay returns the same breakdown without re-booking.
    const existing = await exec
      .select({ transaction_id: ledger.transaction_id })
      .from(ledger)
      .where(eq(ledger.transaction_id, transactionId))
      .limit(1);
    if (existing[0]) return breakdown;

    const metadata = {
      model: input.model,
      trigger: input.trigger,
      ...(input.installmentNumber !== undefined && { installment_number: input.installmentNumber }),
    };

    const entries = [
      {
        transactionId,
        accountType: 'receivable' as const,
        accountRef: input.customerPlanId,
        direction: 'debit' as const,
        amountPesewas: breakdown.grossPesewas,
        description: `Receivable on ${input.trigger}`,
        metadata,
      },
      {
        transactionId,
        accountType: 'merchant_payable' as const,
        accountRef: input.merchantId,
        direction: 'credit' as const,
        amountPesewas: breakdown.netPesewas,
        description: `Merchant payable on ${input.trigger}`,
        metadata,
      },
      {
        transactionId,
        accountType: 'revenue' as const,
        accountRef: PLATFORM_ACCOUNT_REF,
        direction: 'credit' as const,
        amountPesewas: breakdown.mdrPesewas,
        description: `MDR revenue on ${input.trigger}`,
        metadata,
      },
      {
        transactionId,
        accountType: 'reserve_held' as const,
        accountRef: input.customerPlanId,
        direction: 'credit' as const,
        amountPesewas: breakdown.reservePesewas,
        description: `Reserve withheld on ${input.trigger}`,
        metadata,
      },
    ].filter((e) => e.amountPesewas > 0); // ledger rejects 0-amount rows

    await this.ledger.record(entries, tx);
    return breakdown;
  }

  private buildTransactionId(input: RecordPayoutAccrualInput): string {
    const base = `accrue:${input.customerPlanId}:${input.trigger}`;
    return input.trigger === 'installment_n' ? `${base}:${input.installmentNumber}` : base;
  }

  /**
   * Books the proportional inverse of every accrual that has fired for the
   * plan, scaled by how much of the total accrued gross the refund represents.
   * Each per-trigger reversal is balanced by construction (gross → mdr →
   * reserve → net = gross - mdr - reserve), mirroring the forward math.
   *
   * One refund transaction per source accrual: `refund:{scheduleId}:{trigger}`.
   * Replays are idempotent — already-booked reversals are skipped and replayed
   * back in the summary.
   *
   * Returns `null` when no accruals have fired for the plan yet (nothing to
   * reverse — e.g. layaway pre-completion).
   */
  async reverseAccrualsForRefund(
    input: ReverseAccrualsForRefundInput,
    tx?: LedgerExecutor,
  ): Promise<RefundReversalSummary | null> {
    if (input.refundAmountPesewas <= 0) return null;

    const exec: LedgerExecutor = tx ?? this.db;
    const accrualPrefix = `accrue:${input.customerPlanId}:`;
    const accrualRows = await exec
      .select()
      .from(ledger)
      .where(like(ledger.transaction_id, `${accrualPrefix}%`));
    if (accrualRows.length === 0) return null;

    // Sum the receivable debits to get the gross total accrued so far.
    const totalAccruedGross = accrualRows
      .filter((r) => r.account_type === 'receivable' && r.direction === 'debit')
      .reduce((sum, r) => sum + Number(r.amount_pesewas), 0);
    if (totalAccruedGross === 0) return null;

    // Refund's fraction of the total accrued (cap at 100% — can't reverse more
    // than what was booked).
    const scaleBps = Math.min(
      10_000,
      Math.round((input.refundAmountPesewas * 10_000) / totalAccruedGross),
    );
    if (scaleBps === 0) return null;

    const byTransactionId = new Map<string, typeof accrualRows>();
    for (const row of accrualRows) {
      const bucket = byTransactionId.get(row.transaction_id);
      if (bucket) bucket.push(row);
      else byTransactionId.set(row.transaction_id, [row]);
    }

    const config = MODEL_CONFIG[input.model];
    const reversals: RefundReversalSummary['reversals'] = [];
    let totalReversedGross = 0;

    for (const [accrualTxId, rows] of byTransactionId) {
      const triggerSuffix = accrualTxId.slice(accrualPrefix.length);
      const refundTxId = `refund:${input.scheduleId}:${triggerSuffix}`;

      const reversalGross = Money.fromPesewas(
        rows
          .filter((r) => r.account_type === 'receivable' && r.direction === 'debit')
          .reduce((sum, r) => sum + Number(r.amount_pesewas), 0),
      )
        .multiplyBps(scaleBps)
        .toNumber();
      if (reversalGross === 0) continue;

      // mdr/reserve recomputed from gross so the row sums stay balanced
      // regardless of rounding (net absorbs the residual).
      const reversalMdr = Money.fromPesewas(reversalGross).multiplyBps(config.mdrBps).toNumber();
      const reversalReserve = Money.fromPesewas(reversalGross)
        .multiplyBps(config.reserveBps)
        .toNumber();
      const reversalNet = reversalGross - reversalMdr - reversalReserve;

      // Idempotency: a replay returns the same summary without re-booking.
      const existing = await exec
        .select({ transaction_id: ledger.transaction_id })
        .from(ledger)
        .where(eq(ledger.transaction_id, refundTxId))
        .limit(1);
      const alreadyBooked = Boolean(existing[0]);

      if (!alreadyBooked) {
        const merchantPayableRow = rows.find((r) => r.account_type === 'merchant_payable');
        if (!merchantPayableRow) {
          throw new Error(
            `Cannot reverse accrual ${accrualTxId}: no merchant_payable row to read merchantId from`,
          );
        }
        const metadata = {
          model: input.model,
          trigger: triggerSuffix,
          refund_of: accrualTxId,
          schedule_id: input.scheduleId,
        };
        const entries = [
          {
            transactionId: refundTxId,
            accountType: 'receivable' as const,
            accountRef: input.customerPlanId,
            direction: 'credit' as const,
            amountPesewas: reversalGross,
            description: `Refund reversal of ${triggerSuffix}`,
            metadata,
          },
          {
            transactionId: refundTxId,
            accountType: 'merchant_payable' as const,
            accountRef: merchantPayableRow.account_ref,
            direction: 'debit' as const,
            amountPesewas: reversalNet,
            description: `Claw back merchant payable for refund`,
            metadata,
          },
          {
            transactionId: refundTxId,
            accountType: 'revenue' as const,
            accountRef: PLATFORM_ACCOUNT_REF,
            direction: 'debit' as const,
            amountPesewas: reversalMdr,
            description: `Claw back MDR for refund`,
            metadata,
          },
          {
            transactionId: refundTxId,
            accountType: 'reserve_held' as const,
            accountRef: input.customerPlanId,
            direction: 'debit' as const,
            amountPesewas: reversalReserve,
            description: `Release reserve for refund`,
            metadata,
          },
        ].filter((e) => e.amountPesewas > 0);
        await this.ledger.record(entries, tx);
      }

      reversals.push({
        accrualTransactionId: accrualTxId,
        refundTransactionId: refundTxId,
        grossPesewas: reversalGross,
        netPesewas: reversalNet,
        mdrPesewas: reversalMdr,
        reservePesewas: reversalReserve,
      });
      totalReversedGross += reversalGross;
    }

    return { totalReversedGrossPesewas: totalReversedGross, reversals };
  }
}
