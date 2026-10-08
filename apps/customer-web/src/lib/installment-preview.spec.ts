import { describe, expect, it } from 'vitest';
import type { PlanTemplate } from '@installment/api-types';
import { previewPlan, isEligible, cadenceLabel } from './installment-preview';

/**
 * The web preview against the engine's arithmetic.
 *
 * `PlanQuoteService` runs `ScheduleGenerator` — the same class activation runs
 * — and its docstring says "There is deliberately no second implementation
 * anywhere to drift from this one." This file is that second implementation,
 * and it had drifted: `totalPayablePesewas` was built from `financed` rather
 * than the order amount, so on any plan with a deposit the "Total" printed at
 * checkout excluded the deposit printed beside it on the same line.
 *
 * The engine's invariants, which these pin:
 *
 *   down       = round(order x down_payment_bps / 10000)
 *   financed   = order - down
 *   interest   = round(financed x interest_rate_bps / 10000)
 *   total      = order + interest + fees        <- NOT financed + ...
 *   perRow     = ceil((financed + interest + fees) / n)   (largest row)
 *
 * Note `total` counts the deposit, and the instalments cover only the financed
 * part plus interest and fees. Both are needed and they are not the same
 * number.
 */
function template(over: Partial<PlanTemplate> = {}): PlanTemplate {
  return {
    id: 'tpl-1',
    name: 'Pay in 4',
    description: null,
    business_model: 'bnpl',
    number_of_installments: 3,
    installment_frequency_days: 7,
    down_payment_bps: 4_000,
    interest_rate_bps: 0,
    service_fee_flat_pesewas: 0,
    late_fee_pesewas: 0,
    grace_period_days: 3,
    min_amount_pesewas: 1_000,
    max_amount_pesewas: 1_000_000,
    is_active: true,
    ...over,
  } as unknown as PlanTemplate;
}

describe('previewPlan', () => {
  it('counts the deposit in the total the customer is shown', () => {
    // GHS 400 at a 40% deposit. The checkout prints "GHS 160.00 upfront" and
    // "Total ..." on the same line; a total of 240 would be the financed part
    // only, contradicting the figure next to it.
    const p = previewPlan(template(), 40_000);
    expect(p.downPaymentPesewas).toBe(16_000);
    expect(p.financedPesewas).toBe(24_000);
    expect(p.totalPayablePesewas).toBe(40_000);
  });

  it('keeps total = order + interest + fees', () => {
    const t = template({ interest_rate_bps: 500, service_fee_flat_pesewas: 1_500 });
    const order = 40_000;
    const p = previewPlan(t, order);
    const interest = Math.round((p.financedPesewas * 500) / 10_000);
    expect(p.totalPayablePesewas).toBe(order + interest + 1_500);
  });

  it('its own parts always sum to the total', () => {
    for (const bps of [0, 1_000, 2_500, 4_000, 10_000]) {
      for (const order of [1_000, 9_999, 40_000, 123_457, 999_999]) {
        const t = template({
          down_payment_bps: bps,
          interest_rate_bps: 750,
          service_fee_flat_pesewas: 250,
        });
        const p = previewPlan(t, order);
        const interest = Math.round((p.financedPesewas * 750) / 10_000);
        expect(p.downPaymentPesewas + p.financedPesewas).toBe(order);
        expect(p.totalPayablePesewas).toBe(order + interest + 250);
      }
    }
  });

  it('the instalments cover the financed part, not the deposit', () => {
    const t = template({ down_payment_bps: 4_000, number_of_installments: 3 });
    const p = previewPlan(t, 40_000);
    // 24_000 over 3 rows; the deposit is collected separately.
    expect(p.perInstallmentPesewas).toBe(8_000);
    expect(p.perInstallmentPesewas * p.installments).toBeGreaterThanOrEqual(p.financedPesewas);
  });

  it('rounds the per-instalment figure up, matching the generator largest row', () => {
    // The generator floors the base row and spreads the remainder one pesewa at
    // a time onto the earliest rows, so its largest row is ceil(total / n).
    const t = template({ down_payment_bps: 0, number_of_installments: 3 });
    const p = previewPlan(t, 10_000);
    expect(p.perInstallmentPesewas).toBe(Math.ceil(10_000 / 3));
  });

  it('a zero-deposit plan finances the whole order', () => {
    const p = previewPlan(template({ down_payment_bps: 0 }), 40_000);
    expect(p.downPaymentPesewas).toBe(0);
    expect(p.financedPesewas).toBe(40_000);
    expect(p.totalPayablePesewas).toBe(40_000);
  });
});

describe('isEligible', () => {
  it('is inclusive at both ends', () => {
    const t = template({ min_amount_pesewas: 1_000, max_amount_pesewas: 5_000 });
    expect(isEligible(t, 999)).toBe(false);
    expect(isEligible(t, 1_000)).toBe(true);
    expect(isEligible(t, 5_000)).toBe(true);
    expect(isEligible(t, 5_001)).toBe(false);
  });
});

describe('cadenceLabel', () => {
  it('names the three frequencies the schema allows', () => {
    expect(cadenceLabel(7)).toBe('week');
    expect(cadenceLabel(14)).toBe('2 weeks');
    expect(cadenceLabel(30)).toBe('month');
  });
});
