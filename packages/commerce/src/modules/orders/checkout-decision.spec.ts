import { describe, expect, it, vi } from 'vitest';
import { CheckoutDecisionService } from './checkout-decision.service';
import type { OrderWithItems } from './orders.service';

/**
 * The three outcomes the BNPL approval sheet renders, plus the failure the
 * customer must never be shown as a decline.
 *
 * Driven with stubs rather than the live ruleset on purpose: the engine's own
 * scoring is tested in packages/core, and pinning this behaviour to the current
 * rule weights would make a risk-appetite change break a UI contract.
 */

const ACTOR = { actorId: 'cust-1', actorType: 'customer' as const };

function order(overrides: Partial<OrderWithItems> = {}): OrderWithItems {
  return {
    id: 'order-1',
    customer_id: 'cust-1',
    payment_type: 'installment',
    application_id: 'app-1',
    status: 'pending_approval',
    items: [],
    ...overrides,
  } as OrderWithItems;
}

function harness(opts: { outcome?: string; scoreThrows?: boolean; planId?: string | null }) {
  const activated = order({ status: 'financing_active', customer_plan_id: 'plan-1' });
  const declined = order({ status: 'declined' });

  const orders = {
    declineFinancing: vi.fn().mockResolvedValue(declined),
    activateFinancing: vi.fn().mockResolvedValue(activated),
  };
  const scoring = {
    scoreApplication: opts.scoreThrows
      ? vi.fn().mockRejectedValue(new Error('signal collector timed out'))
      : vi.fn().mockResolvedValue({
          decision: { outcome: opts.outcome ?? 'approved' },
          creditProfile: { id: 'profile-1', approved_limit_pesewas: 350_000 },
        }),
  };
  const plans = {
    get: vi.fn().mockResolvedValue({ id: 'plan-1', down_payment_pesewas: 6_400 }),
    getSchedule: vi.fn().mockResolvedValue([
      { id: 's1', sequence_number: 1, amount_due_pesewas: 6_400 },
      { id: 's2', sequence_number: 2, amount_due_pesewas: 3_200 },
    ]),
  };
  const credit = { recordDecision: vi.fn().mockResolvedValue(undefined) };
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([{ id: opts.planId ?? 'plan-1' }]) }),
      }),
    }),
  };

  const service = new CheckoutDecisionService(
    db as never,
    orders as never,
    {} as never,
    scoring as never,
    plans as never,
    credit as never,
  );
  return { service, orders, scoring, plans, credit };
}

describe('CheckoutDecisionService', () => {
  it('activates the plan and hands back the deposit when the engine approves', async () => {
    const { service, orders, credit } = harness({ outcome: 'approved' });

    const [decided] = await service.decideAll([order()], ACTOR);

    expect(decided!.outcome).toBe('approved');
    expect(orders.activateFinancing).toHaveBeenCalledWith('order-1', ACTOR, expect.any(Date));
    expect(decided!.order.status).toBe('financing_active');
    expect(decided!.schedule).toHaveLength(2);
    // The deposit is sequence 1 — what the sheet asks the customer to pay now.
    expect(decided!.down_payment?.amount_due_pesewas).toBe(6_400);
    expect(decided!.approved_limit_pesewas).toBe(350_000);
    expect(credit.recordDecision).toHaveBeenCalledWith(
      'cust-1',
      350_000,
      'profile-1',
      expect.any(Date),
    );
  });

  it('treats a tier-2 approval as an approval', async () => {
    const { service, orders } = harness({ outcome: 'approved_tier_2' });
    const [decided] = await service.decideAll([order()], ACTOR);
    expect(decided!.outcome).toBe('approved');
    expect(orders.activateFinancing).toHaveBeenCalled();
  });

  it('declines the order and releases its stock when the engine declines', async () => {
    const { service, orders } = harness({ outcome: 'declined' });

    const [decided] = await service.decideAll([order()], ACTOR);

    expect(decided!.outcome).toBe('declined');
    expect(orders.declineFinancing).toHaveBeenCalledWith('order-1', ACTOR, expect.any(Date));
    expect(orders.activateFinancing).not.toHaveBeenCalled();
    expect(decided!.plan).toBeNull();
    expect(decided!.message).toMatch(/Nothing was charged/);
  });

  it('does NOT auto-activate a counter offer', async () => {
    // A counter offer is a different plan from the one the customer chose, so
    // activating it would silently sell them terms they never agreed to.
    const { service, orders } = harness({ outcome: 'counter_offer' });

    const [decided] = await service.decideAll([order()], ACTOR);

    expect(decided!.outcome).toBe('in_review');
    expect(orders.activateFinancing).not.toHaveBeenCalled();
    expect(orders.declineFinancing).not.toHaveBeenCalled();
  });

  it('leaves a manual review pending rather than deciding it', async () => {
    const { service, orders } = harness({ outcome: 'manual_review' });
    const [decided] = await service.decideAll([order()], ACTOR);
    expect(decided!.outcome).toBe('in_review');
    expect(decided!.approved_limit_pesewas).toBe(350_000);
    expect(orders.activateFinancing).not.toHaveBeenCalled();
  });

  it('reports a scoring failure as a review, never as a decline', async () => {
    // Scoring is the one step that can fail without the customer having done
    // anything wrong. Declining them for our outage would be both wrong and,
    // because declineFinancing releases the stock, destructive.
    const { service, orders } = harness({ scoreThrows: true });

    const [decided] = await service.decideAll([order()], ACTOR);

    expect(decided!.outcome).toBe('in_review');
    expect(orders.declineFinancing).not.toHaveBeenCalled();
    expect(orders.activateFinancing).not.toHaveBeenCalled();
    expect(decided!.message).toMatch(/reviewing/i);
  });

  it('passes a pay-now order straight through without scoring anything', async () => {
    const { service, scoring } = harness({});

    const [decided] = await service.decideAll(
      [order({ payment_type: 'full', application_id: null })],
      ACTOR,
    );

    expect(decided!.outcome).toBe('paid_later');
    expect(scoring.scoreApplication).not.toHaveBeenCalled();
  });

  it('decides every order a multi-store checkout produced', async () => {
    const { service, orders } = harness({ outcome: 'approved' });

    const decided = await service.decideAll(
      [order({ id: 'order-1' }), order({ id: 'order-2', application_id: 'app-2' })],
      ACTOR,
    );

    expect(decided).toHaveLength(2);
    expect(orders.activateFinancing).toHaveBeenCalledTimes(2);
  });
});
