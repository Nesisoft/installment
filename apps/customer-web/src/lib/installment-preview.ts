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
 * "from GHS X / week" hint on a product. The authoritative figures come from the
 * engine when the plan is generated at checkout — always label this as an
 * estimate, never as the contract.
 */
export function previewPlan(template: PlanTemplate, amountPesewas: number): InstallmentPreview {
  const down = Math.round((amountPesewas * template.down_payment_bps) / 10_000);
  const financed = Math.max(0, amountPesewas - down);
  const interest = Math.round((financed * template.interest_rate_bps) / 10_000);
  const total = financed + interest + template.service_fee_flat_pesewas;
  const n = Math.max(1, template.number_of_installments);
  return {
    downPaymentPesewas: down,
    financedPesewas: financed,
    totalPayablePesewas: total,
    perInstallmentPesewas: Math.ceil(total / n),
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
