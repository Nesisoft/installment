import { describe, expect, it } from 'vitest';
import { ScheduleGenerator } from './schedule-generator';
import { orderShareOf } from './refund-shares';

/** A plan's rows as the generator writes them, with ids to look them up by. */
function plan(order: number, terms: { down?: number; interest?: number; fee?: number; n: number }) {
  const g = new ScheduleGenerator().generate({
    businessModel: 'bnpl',
    gracePeriodDays: 3,
    orderAmountPesewas: order,
    downPaymentBps: terms.down ?? 0,
    interestRateBps: terms.interest ?? 0,
    serviceFeeFlatPesewas: terms.fee ?? 0,
    numberOfInstallments: terms.n,
    installmentFrequencyDays: 30,
    startDate: new Date('2026-11-01T00:00:00Z'),
  });
  const rows = g.installments.map((r, i) => ({
    id: `r${i + 1}`,
    sequence_number: i + 1,
    amount_due_pesewas: r.amountDuePesewas,
  }));
  const shares = rows.map((r) =>
    orderShareOf(
      {
        down_payment_pesewas: g.downPaymentPesewas,
        financed_amount_pesewas: g.financedAmountPesewas,
      },
      rows,
      r.id,
    ),
  );
  return { rows, shares };
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe('orderShareOf', () => {
  it('is the whole instalment on a plan with no interest or fees', () => {
    const { rows, shares } = plan(17_919, { down: 3_000, n: 5 });
    expect(shares).toEqual(rows.map((r) => r.amount_due_pesewas));
  });

  it('is all of the deposit, and the financed part of the rest', () => {
    const { shares } = plan(100_000, { down: 2_000, interest: 1_000, n: 3 });
    expect(shares).toEqual([20_000, 26_667, 26_666, 26_667]);
  });

  it('adds up to exactly the order, whatever the split', () => {
    for (const order of [1_001, 17_919, 99_999, 1_234_567, 9_876_543]) {
      for (const terms of [
        { n: 7, interest: 1_750 },
        { n: 12, interest: 3_000, fee: 999 },
        { n: 5, down: 3_000, interest: 333 },
        { n: 24, down: 1_000, fee: 2_500 },
      ]) {
        const { rows, shares } = plan(order, terms);
        expect(sum(shares)).toBe(order);
        shares.forEach((s, i) => {
          expect(s).toBeGreaterThanOrEqual(0);
          expect(s).toBeLessThanOrEqual(rows[i]!.amount_due_pesewas);
        });
      }
    }
  });

  it('refuses a row that is not one of the originals', () => {
    const { rows } = plan(100_000, { n: 4 });
    expect(() =>
      orderShareOf({ down_payment_pesewas: 0, financed_amount_pesewas: 100_000 }, rows, 'copy'),
    ).toThrow(/not one of the plan's original/);
  });
});
