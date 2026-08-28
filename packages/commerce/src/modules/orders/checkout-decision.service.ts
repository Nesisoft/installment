import { eq } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import {
  ApplicationsService,
  CustomerCreditService,
  CustomerPlansService,
  ScoringService,
  type CustomerPlan,
  type InstallmentScheduleRow,
  type PlanActor,
} from '@installment/core';
import { OrdersService, type OrderWithItems } from './orders.service';

const ord = schema.orders;

export type CheckoutOutcome = 'paid_later' | 'approved' | 'declined' | 'in_review' | 'failed';

export interface DecidedOrder {
  order: OrderWithItems;
  outcome: CheckoutOutcome;
  application_id: string | null;
  plan: CustomerPlan | null;
  schedule: InstallmentScheduleRow[];
  /** The deposit the customer must now pay, when there is one. */
  down_payment: InstallmentScheduleRow | null;
  approved_limit_pesewas: number | null;
  /** Customer-readable reason, for the sheet's declined and in-review states. */
  message: string | null;
}

/**
 * Decides an instalment checkout on the spot.
 *
 * Before this, instalment checkout submitted an application and stopped:
 * scoring was `POST /admin/applications/:id/score` and activation was
 * `POST /admin/plans/from-application/:id`, both staff-only. A customer who
 * checked out on their phone got an order parked in `pending_approval` with no
 * plan, no schedule and no way to pay the deposit — the "approved in seconds"
 * flow the whole app is built around simply could not complete.
 *
 * This runs **after** the checkout transaction has committed, not inside it,
 * because `ScoringService.scoreApplication` and
 * `CustomerPlansService.activateFromApplication` each open their own
 * transaction. That ordering is deliberate and has a consequence worth naming:
 * a crash between the two leaves an approved application whose order is still
 * `pending_approval`. That state is recoverable — it is exactly what the admin
 * activation path handles — which is why that path stays, and why the outcome
 * here degrades to `in_review` rather than failing the checkout. The order and
 * the customer's stock reservation are already safely committed; the worst case
 * is a human finishing the decision.
 */
export class CheckoutDecisionService {
  constructor(
    private readonly db: Database,
    private readonly orders: OrdersService,
    private readonly applications: ApplicationsService,
    private readonly scoring: ScoringService,
    private readonly plans: CustomerPlansService,
    private readonly credit: CustomerCreditService,
  ) {}

  /** Decides every instalment order a checkout produced; pay-now orders pass through. */
  async decideAll(
    orders: OrderWithItems[],
    actor: PlanActor,
    now: Date = new Date(),
  ): Promise<DecidedOrder[]> {
    const decided: DecidedOrder[] = [];
    for (const order of orders) decided.push(await this.decide(order, actor, now));
    return decided;
  }

  async decide(
    order: OrderWithItems,
    actor: PlanActor,
    now: Date = new Date(),
  ): Promise<DecidedOrder> {
    if (order.payment_type !== 'installment' || !order.application_id) {
      return this.plain(order, 'paid_later');
    }

    let approvedLimit: number | null = null;
    let outcome: CheckoutOutcome;

    try {
      const { decision, creditProfile } = await this.scoring.scoreApplication(
        order.application_id,
        actor,
      );
      approvedLimit = Number(creditProfile.approved_limit_pesewas);

      // Keep the customer-visible limit in step with the decision that set it,
      // so the Wallet screen and the approval sheet agree.
      await this.credit
        .recordDecision(order.customer_id, approvedLimit, creditProfile.id, now)
        .catch(() => {
          /* a stale limit display must not fail a completed decision */
        });

      // The engine has five outcomes; the sheet has three states. `counter_offer`
      // and `manual_review` both mean "not yet, a human decides" — and a counter
      // offer in particular must NOT auto-activate, because the plan it would
      // activate is not the one the customer asked for.
      outcome =
        decision.outcome === 'approved' || decision.outcome === 'approved_tier_2'
          ? 'approved'
          : decision.outcome === 'declined'
            ? 'declined'
            : 'in_review';
    } catch {
      // Scoring is the only step that can fail without the customer having done
      // anything wrong (a signal collector timing out, say). The order stays in
      // pending_approval, which is precisely the state the admin queue exists
      // for, and the sheet tells the customer it is being reviewed.
      return this.plain(order, 'in_review', {
        message: 'We are reviewing your application and will let you know shortly.',
      });
    }

    if (outcome === 'declined') {
      const declined = await this.orders.declineFinancing(order.id, actor, now);
      return this.plain(declined, 'declined', {
        message:
          'We could not approve instalments for this order. Nothing was charged and your items are back on sale.',
      });
    }

    if (outcome === 'in_review') {
      return this.plain(order, 'in_review', {
        approvedLimit,
        message: 'Your application needs a quick manual check. We will let you know shortly.',
      });
    }

    const activated = await this.orders.activateFinancing(order.id, actor, now);
    const planId = await this.planIdFor(activated.id);
    const plan = planId ? await this.plans.get(planId) : null;
    const schedule = planId ? await this.plans.getSchedule(planId) : [];

    return {
      order: activated,
      outcome: 'approved',
      application_id: order.application_id,
      plan,
      schedule,
      // The deposit is always sequence 1 and only exists when the plan has one;
      // `kind` is generator-only and not stored, so this is how it is identified
      // everywhere in the codebase.
      down_payment:
        plan && plan.down_payment_pesewas > 0
          ? (schedule.find((s) => s.sequence_number === 1) ?? null)
          : null,
      approved_limit_pesewas: approvedLimit,
      message: null,
    };
  }

  private async planIdFor(orderId: string): Promise<string | null> {
    const rows = await this.db
      .select({ id: ord.customer_plan_id })
      .from(ord)
      .where(eq(ord.id, orderId))
      .limit(1);
    return rows[0]?.id ?? null;
  }

  private plain(
    order: OrderWithItems,
    outcome: CheckoutOutcome,
    extra: { message?: string; approvedLimit?: number | null } = {},
  ): DecidedOrder {
    return {
      order,
      outcome,
      application_id: order.application_id ?? null,
      plan: null,
      schedule: [],
      down_payment: null,
      approved_limit_pesewas: extra.approvedLimit ?? null,
      message: extra.message ?? null,
    };
  }
}
