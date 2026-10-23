import { describe, expect, it } from 'vitest';
import {
  basketCost,
  cheapestCommonPlans,
  commonEligibleTemplateIds,
  ordersPlanLines,
  planLines,
  shopOrders,
} from './basket';

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

describe('shopOrders', () => {
  const lines = [
    { store_id: 'a', store_display_name: 'Kente House', line_total_pesewas: 115_000 },
    { store_id: 'b', store_display_name: 'Osu Tech', line_total_pesewas: 195_000 },
    { store_id: 'a', store_display_name: 'Kente House', line_total_pesewas: 5_000 },
  ];

  it('makes one order per shop, each carrying its own delivery fee', () => {
    // What the server created for this basket: two orders, GHS 15 each.
    expect(shopOrders(lines, { pickup: false, feePesewas: 1_500 })).toEqual([
      { storeId: 'a', name: 'Kente House', subtotalPesewas: 120_000, amountPesewas: 121_500 },
      { storeId: 'b', name: 'Osu Tech', subtotalPesewas: 195_000, amountPesewas: 196_500 },
    ]);
  });

  it('leaves each amount unknown until delivery is priced, and free for pickup', () => {
    expect(
      shopOrders(lines, { pickup: false, feePesewas: undefined }).map((s) => s.amountPesewas),
    ).toEqual([null, null]);
    expect(
      shopOrders(lines, { pickup: true, feePesewas: undefined }).map((s) => s.amountPesewas),
    ).toEqual([120_000, 195_000]);
  });
});

describe('commonEligibleTemplateIds', () => {
  const q = (id: string, eligible: boolean) => ({ plan_template_id: id, eligible });

  it("offers only the plans every shop's order qualifies for", () => {
    // One template is sent for every order; a plan one order is too small for
    // would decline that order.
    expect(
      commonEligibleTemplateIds([
        [q('pay4', true), q('pay6', true)],
        [q('pay4', true), q('pay6', false)],
      ]),
    ).toEqual(['pay4']);
  });

  it('waits until every shop has been quoted', () => {
    expect(commonEligibleTemplateIds([[q('pay4', true)], undefined])).toBeNull();
  });
});

describe('cheapestCommonPlans', () => {
  const q = (id: string, per: number, eligible = true) => ({
    plan_template_id: id,
    eligible,
    per_installment_pesewas: per,
  });

  it("returns each shop's plan on the template with the smallest instalments", () => {
    expect(
      cheapestCommonPlans([
        [q('pay4', 3_200), q('pay6', 2_100)],
        [q('pay4', 6_700), q('pay6', 4_500)],
      ]),
    ).toEqual([q('pay6', 2_100), q('pay6', 4_500)]);
  });

  it('never picks a template one of the orders does not qualify for', () => {
    expect(
      cheapestCommonPlans([
        [q('pay4', 3_200), q('pay6', 2_100)],
        [q('pay4', 6_700), q('pay6', 4_500, false)],
      ]),
    ).toEqual([q('pay4', 3_200), q('pay4', 6_700)]);
  });

  it('has nothing to offer until every shop is quoted, or when no plan fits them all', () => {
    expect(cheapestCommonPlans([[q('pay4', 3_200)], undefined])).toBeNull();
    expect(cheapestCommonPlans([[q('pay4', 3_200)], [q('pay6', 4_500)]])).toBeNull();
  });
});

describe('ordersPlanLines', () => {
  const plan = (deposit: number, rows: number) => ({
    down_payment_pesewas: deposit,
    number_of_installments: deposit > 0 ? rows - 1 : rows,
    per_installment_pesewas: 3_200,
    installment_frequency_days: 7,
    installments: Array.from({ length: rows }, () => ({}) as never),
  });

  it('reads one order as its own plan', () => {
    expect(ordersPlanLines([plan(6_400, 4)])).toEqual(planLines(plan(6_400, 4)));
  });

  it("totals what is due today across the orders' own deposits", () => {
    // Reproduced: GHS 160 and GHS 335 orders on "Pay in 4" have deposits of
    // GHS 64 and GHS 134. Quoting the GHS 495 total as one plan is not what
    // either order is given; at larger amounts the rounding differs too.
    expect(ordersPlanLines([plan(6_400, 4), plan(13_400, 4)])).toEqual({
      lead: 'Pay GHS 198 today',
      rest: '2 orders, each on its own plan',
    });
  });

  it('says how many payments when nothing is due today', () => {
    expect(ordersPlanLines([plan(0, 4), plan(0, 4)])).toEqual({
      lead: 'Pay in 4',
      rest: '2 orders, each on its own plan',
    });
  });
});
