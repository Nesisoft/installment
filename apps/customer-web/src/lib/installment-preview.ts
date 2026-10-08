import type { PlanTemplate } from '@installment/api-types';

export interface InstallmentPreview {
  downPaymentPesewas: number;
  financedPesewas: number;
  totalPayablePesewas: number;
  perInstallmentPesewas: number;
  installments: number;
  frequencyDays: number;
}

/**
 * Client-side ESTIMATE of what a plan would cost for `amountPesewas`, for the
 * "from GHS X / week" hint on a product. The authoritative figures come from
 * the engine when the plan is generated at checkout — always label this as an
 * estimate, never as the contract.
 *
 * It must still agree with `ScheduleGenerator`, whose arithmetic is:
 *
 *   down     = round(order x down_payment_bps / 10000)
 *   financed = order - down
 *   interest = round(financed x interest_rate_bps / 10000)
 *   total    = order + interest + fees
 *   perRow   = ceil((financed + interest + fees) / n)
 *
 * `total` counts the deposit; the instalments cover only the financed part
 * plus interest and fees. Those are different numbers, and building `total`
 * from `financed` dropped the deposit out of the figure the checkout prints as
 * "Total" — beside the deposit itself, on the same line. `installment-preview
 * .spec.ts` pins the relationship so the two cannot drift apart again.
 */
export function previewPlan(template: PlanTemplate, amountPesewas: number): InstallmentPreview {
  const down = Math.round((amountPesewas * template.down_payment_bps) / 10_000);
  const financed = Math.max(0, amountPesewas - down);
  const interest = Math.round((financed * template.interest_rate_bps) / 10_000);
  // What the customer pays in all: the deposit plus everything the
  // instalments collect.
  const total = amountPesewas + interest + template.service_fee_flat_pesewas;
  // What the instalments themselves have to cover — the deposit is collected
  // separately, so it is not in this split.
  const financedTotal = financed + interest + template.service_fee_flat_pesewas;
  const n = Math.max(1, template.number_of_installments);
  return {
    downPaymentPesewas: down,
    financedPesewas: financed,
    totalPayablePesewas: total,
    perInstallmentPesewas: Math.ceil(financedTotal / n),
    installments: n,
    frequencyDays: template.installment_frequency_days,
  };
}

/** Whether a plan may be used for this order amount. */
export function isEligible(template: PlanTemplate, amountPesewas: number): boolean {
  return (
    amountPesewas >= template.min_amount_pesewas && amountPesewas <= template.max_amount_pesewas
  );
}

export function cadenceLabel(frequencyDays: number): string {
  if (frequencyDays === 7) return 'week';
  if (frequencyDays === 14) return '2 weeks';
  if (frequencyDays === 30) return 'month';
  return `${frequencyDays} days`;
}
