import { eq } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import { LedgerService, type LedgerExecutor } from '../../shared/ledger/ledger.service';
import { PayoutCalculator, type PayoutBreakdown } from './payout-calculator';
import type { BusinessModel, PayoutTrigger } from './model-config';

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
}
