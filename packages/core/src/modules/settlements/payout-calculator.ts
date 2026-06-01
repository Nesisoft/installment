import { Money } from '../../shared/money/money';
import { MODEL_CONFIG, type BusinessModel, type PayoutTrigger } from './model-config';

export interface PayoutBreakdown {
  /** Gross slice of the order this payout represents (pesewas). */
  grossPesewas: number;
  /** Merchant Discount Rate deducted (pesewas). */
  mdrPesewas: number;
  /** Reserve withheld (pesewas). */
  reservePesewas: number;
  /** Cash actually owed to the merchant for this slice (gross − mdr − reserve). */
  netPesewas: number;
  /** Platform's revenue. The reserve is NOT revenue — it's a liability that may return. */
  platformRevenuePesewas: number;
}

/**
 * Pure payout math (ported from docs/design/settlement-engine.ts). For one
 * order + model + trigger, returns the slice and how the platform splits it
 * (merchant net / MDR / reserve), or `null` if the model has no payout for
 * that trigger. All intermediate math is rounded to whole pesewas with
 * ROUND_HALF_UP (via Money / decimal.js).
 */
export class PayoutCalculator {
  static calculate(
    orderAmountPesewas: number,
    model: BusinessModel,
    trigger: PayoutTrigger,
    options?: { installmentNumber?: number },
  ): PayoutBreakdown | null {
    const config = MODEL_CONFIG[model];
    const split = config.payoutSplits.find(
      (s) =>
        s.trigger === trigger &&
        (s.trigger !== 'installment_n' || s.installmentNumber === options?.installmentNumber),
    );
    if (!split) return null;

    // percentOfOrder → bps so the rounding uses the same ROUND_HALF_UP rule.
    const percentBps = Math.round(split.percentOfOrder * 10_000);
    const gross = Money.fromPesewas(orderAmountPesewas).multiplyBps(percentBps);
    const mdr = gross.multiplyBps(config.mdrBps);
    const reserve = gross.multiplyBps(config.reserveBps);
    const grossN = gross.toNumber();
    const mdrN = mdr.toNumber();
    const reserveN = reserve.toNumber();

    return {
      grossPesewas: grossN,
      mdrPesewas: mdrN,
      reservePesewas: reserveN,
      netPesewas: grossN - mdrN - reserveN,
      platformRevenuePesewas: mdrN,
    };
  }
}
