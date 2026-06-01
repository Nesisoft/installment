/**
 * Per-business-model settlement configuration (ported from
 * docs/design/settlement-engine.ts). Pure data — the calculator and the
 * payout recorder both read from this single source.
 */
export type BusinessModel = 'bnpl' | 'layaway' | 'hybrid' | 'rent_to_own';

/** When a slice of the order pays out (one event per row in `payoutSplits`). */
export type PayoutTrigger =
  | 'order_approved'
  | 'down_payment_received'
  | 'installment_n'
  | 'plan_completed';

export interface PayoutSplit {
  trigger: PayoutTrigger;
  /** Only for `installment_n`. */
  installmentNumber?: number;
  /** Fraction of the order amount this split represents (0..1, summing to 1). */
  percentOfOrder: number;
}

/** When the held reserve becomes the merchant's again. */
export type ReleasePolicy =
  | { type: 'after_plan_completion'; bufferDays: number }
  | { type: 'after_delivery'; bufferDays: number }
  | { type: 'rolling_monthly'; months: number };

export interface ModelConfig {
  payoutSplits: PayoutSplit[];
  /** Merchant Discount Rate, basis points (400 = 4%). */
  mdrBps: number;
  /** Reserve withheld from the merchant, basis points of the gross payout. */
  reserveBps: number;
  reserveReleasePolicy: ReleasePolicy;
}

export const MODEL_CONFIG: Record<BusinessModel, ModelConfig> = {
  bnpl: {
    payoutSplits: [{ trigger: 'order_approved', percentOfOrder: 1.0 }],
    mdrBps: 400, // 4%
    reserveBps: 500, // 5%
    reserveReleasePolicy: { type: 'after_plan_completion', bufferDays: 14 },
  },
  layaway: {
    payoutSplits: [{ trigger: 'plan_completed', percentOfOrder: 1.0 }],
    mdrBps: 300, // 3% — platform never held the cash
    reserveBps: 200, // 2%
    reserveReleasePolicy: { type: 'after_delivery', bufferDays: 7 },
  },
  hybrid: {
    payoutSplits: [
      { trigger: 'down_payment_received', percentOfOrder: 0.4 },
      { trigger: 'plan_completed', percentOfOrder: 0.6 },
    ],
    mdrBps: 400,
    reserveBps: 700, // 7% — split risk
    reserveReleasePolicy: { type: 'after_plan_completion', bufferDays: 14 },
  },
  rent_to_own: {
    payoutSplits: [{ trigger: 'order_approved', percentOfOrder: 1.0 }],
    mdrBps: 500, // 5%
    reserveBps: 1200, // 12% — long-tail risk
    reserveReleasePolicy: { type: 'rolling_monthly', months: 12 },
  },
};
