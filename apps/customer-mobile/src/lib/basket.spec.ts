import { describe, expect, it } from 'vitest';
import { basketCost, planLines } from './basket';

describe('basketCost', () => {
  it('charges delivery once per shop, as checkout splits the basket', () => {
    // Reproduced: two shops, GHS 15 courier each — orders of GHS 1,165 and
    // GHS 1,965. The screen said GHS 3,115; they came to GHS 3,130.
    expect(
      basketCost({ subtotalPesewas: 310_000, storeCount: 2, pickup: false, feePesewas: 1_500 }),
    ).toEqual({ deliveryPesewas: 3_000, totalPesewas: 313_000 });
  });

  it('does not price delivery it has not been quoted', () => {
    expect(
      basketCost({ subtotalPesewas: 32_000, storeCount: 1, pickup: false, feePesewas: undefined }),
    ).toEqual({ deliveryPesewas: null, totalPesewas: null });
  });

  it('takes pickup as free, quote or no quote', () => {
    expect(
      basketCost({ subtotalPesewas: 32_000, storeCount: 3, pickup: true, feePesewas: undefined }),
    ).toEqual({ deliveryPesewas: 0, totalPesewas: 32_000 });
  });

  it('counts a free courier fee as free, not unknown', () => {
    expect(
      basketCost({ subtotalPesewas: 32_000, storeCount: 1, pickup: false, feePesewas: 0 }),
    ).toEqual({ deliveryPesewas: 0, totalPesewas: 32_000 });
  });
});

describe('planLines', () => {
  const rows = (n: number) => Array.from({ length: n }, () => ({}) as never);

  it('leads with the deposit, then the payments after it', () => {
    expect(
      planLines({
        down_payment_pesewas: 124_600,
        number_of_installments: 3,
        per_installment_pesewas: 62_300,
        installment_frequency_days: 7,
        installments: rows(4),
      }),
    ).toEqual({ lead: 'Pay GHS 1,246 today', rest: 'then 3 × GHS 623 weekly' });
  });

  it('says nothing is due today on a plan with no deposit', () => {
    // It read "Pay GHS 0 today, then 4 × GHS 779" — 778.75, rounded.
    expect(
      planLines({
        down_payment_pesewas: 0,
        number_of_installments: 4,
        per_installment_pesewas: 77_875,
        installment_frequency_days: 7,
        installments: rows(4),
      }),
    ).toEqual({ lead: 'Pay in 4', rest: '4 × GHS 778.75 weekly, nothing today' });
  });
});
