import { Money } from '../../shared/money/money';

export type ScheduleBusinessModel = 'bnpl' | 'layaway' | 'hybrid' | 'rent_to_own';

export interface ScheduleGenerationInput {
  /**
   * Stored on the resulting plan. Row generation is parameter-driven and the
   * same across models — per-model differences are in payout/delivery timing
   * (settlement, later phases), not in the installment math.
   */
  businessModel: ScheduleBusinessModel;
  orderAmountPesewas: number;
  downPaymentBps: number;
  interestRateBps: number;
  serviceFeeFlatPesewas: number;
  numberOfInstallments: number;
  installmentFrequencyDays: number;
  gracePeriodDays: number;
  /** Anchor date; a down-payment row (if any) is due on this date. */
  startDate: Date;
}

export type InstallmentKind = 'down_payment' | 'installment';

export interface GeneratedInstallment {
  sequenceNumber: number;
  kind: InstallmentKind;
  amountDuePesewas: number;
  dueDate: string; // YYYY-MM-DD
  graceUntilDate: string; // YYYY-MM-DD
}

export interface GeneratedSchedule {
  downPaymentPesewas: number;
  financedAmountPesewas: number;
  totalInterestPesewas: number;
  totalFeesPesewas: number;
  totalPayablePesewas: number;
  /** The down-payment row (when present) followed by the financed installments. */
  installments: GeneratedInstallment[];
}

export class ScheduleGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScheduleGenerationError';
  }
}

const MS_PER_DAY = 86_400_000;

function addDaysIso(start: Date, days: number): string {
  return new Date(start.getTime() + days * MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * Turns an approved plan's terms into a concrete installment schedule.
 *
 * Money breakdown: down payment = order × downPaymentBps; financed = order −
 * down; interest = financed × interestRateBps; total payable = order + interest
 * + fees. Everything except the down payment is split across N installments
 * (remainder spread one pesewa at a time so the rows sum exactly to the total
 * payable). A down-payment row, when the down payment is non-zero, is due on the
 * start date; installment i is due on start + i × frequency.
 */
export class ScheduleGenerator {
  generate(input: ScheduleGenerationInput): GeneratedSchedule {
    const {
      orderAmountPesewas,
      downPaymentBps,
      interestRateBps,
      serviceFeeFlatPesewas,
      numberOfInstallments: n,
      installmentFrequencyDays,
      gracePeriodDays,
      startDate,
    } = input;

    if (orderAmountPesewas <= 0) {
      throw new ScheduleGenerationError('orderAmountPesewas must be positive');
    }
    if (n < 1) {
      throw new ScheduleGenerationError('numberOfInstallments must be at least 1');
    }
    if (installmentFrequencyDays <= 0) {
      throw new ScheduleGenerationError('installmentFrequencyDays must be positive');
    }

    const order = Money.fromPesewas(orderAmountPesewas);
    const downPayment = order.multiplyBps(downPaymentBps);
    const financed = order.subtract(downPayment);
    const interest = financed.multiplyBps(interestRateBps);
    const fees = Money.fromPesewas(serviceFeeFlatPesewas);
    const totalPayable = order.add(interest).add(fees);

    // Everything the installments must cover (down payment is billed separately).
    const installmentsTotal = financed.add(interest).add(fees).toNumber();
    if (installmentsTotal < n) {
      throw new ScheduleGenerationError(
        `financed total ${installmentsTotal} is too small to split into ${n} installments`,
      );
    }

    const base = Math.floor(installmentsTotal / n);
    let remainder = installmentsTotal - base * n;

    const installments: GeneratedInstallment[] = [];
    let sequence = 1;
    const downPaymentPesewas = downPayment.toNumber();
    if (downPaymentPesewas > 0) {
      installments.push({
        sequenceNumber: sequence++,
        kind: 'down_payment',
        amountDuePesewas: downPaymentPesewas,
        dueDate: addDaysIso(startDate, 0),
        graceUntilDate: addDaysIso(startDate, gracePeriodDays),
      });
    }

    for (let i = 1; i <= n; i++) {
      const extra = remainder > 0 ? 1 : 0;
      if (remainder > 0) remainder--;
      const dueDays = i * installmentFrequencyDays;
      installments.push({
        sequenceNumber: sequence++,
        kind: 'installment',
        amountDuePesewas: base + extra,
        dueDate: addDaysIso(startDate, dueDays),
        graceUntilDate: addDaysIso(startDate, dueDays + gracePeriodDays),
      });
    }

    return {
      downPaymentPesewas,
      financedAmountPesewas: financed.toNumber(),
      totalInterestPesewas: interest.toNumber(),
      totalFeesPesewas: fees.toNumber(),
      totalPayablePesewas: totalPayable.toNumber(),
      installments,
    };
  }
}
