import { describe, expect, it } from 'vitest';
import { commonEligibleTemplateIds, noPlanReason, shopOrders } from './basket';

describe('shopOrders', () => {
  const line = (store: string, name: string, total: number) => ({
    store_id: store,
    store_display_name: name,
    line_total_pesewas: total,
  });

  it('makes one order per shop, each carrying its own delivery fee', () => {
    // Reproduced on the local stack: GHS 145 + GHS 320 from two shops at GHS 15
    // delivery. The page said GHS 480; the two orders came to GHS 160 + GHS 335.
    const orders = shopOrders(
      [line('a', 'NKULENU BEAUTY', 14_500), line('b', 'Demo Electronics', 32_000)],
      1_500,
    );
    expect(orders.map((o) => o.amountPesewas)).toEqual([16_000, 33_500]);
  });

  it('adds up several lines from the same shop into one order', () => {
    const orders = shopOrders([line('a', 'A', 1_000), line('a', 'A', 2_000)], 500);
    expect(orders).toHaveLength(1);
    expect(orders[0]!.amountPesewas).toBe(3_500);
  });

  it('leaves each amount unknown until delivery is priced', () => {
    expect(shopOrders([line('a', 'A', 1_000)], undefined)[0]!.amountPesewas).toBeNull();
  });
});

describe('commonEligibleTemplateIds', () => {
  const q = (id: string, eligible: boolean) => ({ plan_template_id: id, eligible });

  it("offers only the plans every shop's order qualifies for", () => {
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

describe('noPlanReason', () => {
  const ok = { eligible: true, ineligible_reason: null };
  const small = { eligible: false, ineligible_reason: 'This plan starts at GHS 100' };

  it('names the shop whose order no plan fits, in the plan’s own words', () => {
    expect(
      noPlanReason([{ name: 'OSU TECH HUB' }, { name: 'MAKOLA FOODS' }], [[ok], [small]]),
    ).toBe(
      'Instalments are not available for this basket: no plan fits the MAKOLA FOODS order (this plan starts at GHS 100). Pay in full, or buy from that shop on its own.',
    );
  });

  it('gives a single order the plan’s reason', () => {
    expect(noPlanReason([{ name: 'A' }], [[small]])).toBe(
      'Instalments are not available for this order. This plan starts at GHS 100. You can still pay in full.',
    );
  });
});
