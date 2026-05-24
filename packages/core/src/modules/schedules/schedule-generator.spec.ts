import { describe, expect, it } from 'vitest';
import {
  ScheduleGenerationError,
  ScheduleGenerator,
  type ScheduleGenerationInput,
} from './schedule-generator';

const gen = new ScheduleGenerator();
const START = new Date('2026-01-01T00:00:00.000Z');

function input(overrides: Partial<ScheduleGenerationInput> = {}): ScheduleGenerationInput {
  return {
    businessModel: 'bnpl',
    orderAmountPesewas: 100_000,
    downPaymentBps: 0,
    interestRateBps: 0,
    serviceFeeFlatPesewas: 0,
    numberOfInstallments: 4,
    installmentFrequencyDays: 7,
    gracePeriodDays: 3,
    startDate: START,
    ...overrides,
  };
}

function sum(amounts: number[]): number {
  return amounts.reduce((a, b) => a + b, 0);
}

describe('ScheduleGenerator — BNPL', () => {
  it('generates 4 equal weekly installments with no down-payment row', () => {
    const schedule = gen.generate(input());

    expect(schedule.downPaymentPesewas).toBe(0);
    expect(schedule.totalPayablePesewas).toBe(100_000);
    expect(schedule.installments).toHaveLength(4);
    expect(schedule.installments.every((i) => i.kind === 'installment')).toBe(true);
    expect(schedule.installments.map((i) => i.amountDuePesewas)).toEqual([
      25_000, 25_000, 25_000, 25_000,
    ]);
    expect(schedule.installments.map((i) => i.dueDate)).toEqual([
      '2026-01-08',
      '2026-01-15',
      '2026-01-22',
      '2026-01-29',
    ]);
    expect(schedule.installments[0]!.graceUntilDate).toBe('2026-01-11'); // +3 grace
    expect(sum(schedule.installments.map((i) => i.amountDuePesewas))).toBe(
      schedule.totalPayablePesewas,
    );
  });
});

describe('ScheduleGenerator — hybrid', () => {
  it('generates a down-payment row plus 3 monthly installments', () => {
    const schedule = gen.generate(
      input({
        businessModel: 'hybrid',
        downPaymentBps: 3_000, // 30%
        numberOfInstallments: 3,
        installmentFrequencyDays: 30,
        gracePeriodDays: 5,
      }),
    );

    expect(schedule.downPaymentPesewas).toBe(30_000);
    expect(schedule.financedAmountPesewas).toBe(70_000);
    expect(schedule.installments).toHaveLength(4);

    const down = schedule.installments[0]!;
    expect(down.kind).toBe('down_payment');
    expect(down.sequenceNumber).toBe(1);
    expect(down.amountDuePesewas).toBe(30_000);
    expect(down.dueDate).toBe('2026-01-01');

    const monthly = schedule.installments.slice(1);
    expect(monthly.map((i) => i.kind)).toEqual(['installment', 'installment', 'installment']);
    // 70_000 / 3 → 23_334, 23_333, 23_333 (remainder spread to the first row)
    expect(monthly.map((i) => i.amountDuePesewas)).toEqual([23_334, 23_333, 23_333]);
    expect(monthly[0]!.dueDate).toBe('2026-01-31'); // +30 days
    expect(sum(schedule.installments.map((i) => i.amountDuePesewas))).toBe(100_000);
  });
});

describe('ScheduleGenerator — interest and fees', () => {
  it('adds interest on the financed amount and a flat service fee', () => {
    const schedule = gen.generate(
      input({
        businessModel: 'rent_to_own',
        interestRateBps: 1_000, // 10% of financed 100_000 = 10_000
        serviceFeeFlatPesewas: 500,
        numberOfInstallments: 2,
        installmentFrequencyDays: 30,
      }),
    );

    expect(schedule.totalInterestPesewas).toBe(10_000);
    expect(schedule.totalFeesPesewas).toBe(500);
    expect(schedule.totalPayablePesewas).toBe(110_500);
    expect(schedule.installments.map((i) => i.amountDuePesewas)).toEqual([55_250, 55_250]);
  });
});

describe('ScheduleGenerator — money exactness', () => {
  it('spreads the rounding remainder so rows sum to the total payable', () => {
    const schedule = gen.generate(input({ orderAmountPesewas: 100_000, numberOfInstallments: 3 }));
    expect(schedule.installments.map((i) => i.amountDuePesewas)).toEqual([33_334, 33_333, 33_333]);
    expect(sum(schedule.installments.map((i) => i.amountDuePesewas))).toBe(100_000);
  });
});

describe('ScheduleGenerator — validation', () => {
  it('rejects a non-positive order amount', () => {
    expect(() => gen.generate(input({ orderAmountPesewas: 0 }))).toThrow(ScheduleGenerationError);
  });

  it('rejects fewer than one installment', () => {
    expect(() => gen.generate(input({ numberOfInstallments: 0 }))).toThrow(ScheduleGenerationError);
  });

  it('rejects a financed total too small to split', () => {
    expect(() => gen.generate(input({ orderAmountPesewas: 2, numberOfInstallments: 5 }))).toThrow(
      ScheduleGenerationError,
    );
  });
});
