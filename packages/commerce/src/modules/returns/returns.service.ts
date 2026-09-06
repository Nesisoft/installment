import { and, desc, eq } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import {
  AuditLogger,
  LedgerService,
  Money,
  PLATFORM_ACCOUNT_REF,
  runInTransaction,
  type AuditActorType,
  type LedgerEntryInput,
} from '@installment/core';
import { InventoryService } from '../catalog/inventory.service';
import { assertOrderTransition } from '../orders/order-state';
import type { OrderStatus } from '../orders/order-state';
import {
  listReturnsSchema,
  rejectReturnSchema,
  requestReturnSchema,
  type ListReturnsInput,
  type RejectReturnInput,
  type RequestReturnInput,
} from './dto';
import {
  OrderNotReturnableError,
  ReturnAlreadyDecidedError,
  ReturnAlreadyOpenError,
  ReturnNotFoundError,
  ReturnWindowClosedError,
} from './errors';

const o = schema.orders;
const oi = schema.order_items;
const oe = schema.order_events;
const ret = schema.order_returns;

export type OrderReturn = typeof schema.order_returns.$inferSelect;

export interface ReturnActor {
  actorId: string;
  actorType: AuditActorType;
}

/** Narrows a return operation to one merchant's own orders, or one customer's. */
export interface ReturnScope {
  merchantId?: string;
  customerId?: string;
}

/**
 * The slice of the refund engine this service needs.
 *
 * A narrow port rather than importing `RefundService`: commerce says what it
 * requires and core's real service satisfies it structurally, so the fixtures
 * hand over a plain object and nothing here depends on a Paystack client.
 */
export interface ReturnRefundRecorder {
  recordOrderReturnIntent(
    input: { orderReturnId: string; orderId: string; amountPesewas: number },
    tx: unknown,
  ): Promise<void>;
}

/** The slice of the push notifier this service needs. */
export interface ReturnDecisionNotifier {
  notifyCustomerOfOrderEvent(args: {
    customerId: string;
    orderId: string;
    orderNumber: string;
    eventType: string;
    title: string;
    body: string;
  }): Promise<unknown>;
}

/** The states an order can still be sent back from. */
const RETURNABLE_STATUSES: readonly OrderStatus[] = ['paid', 'shipped', 'delivered'];

/**
 * Sending an order back, and the decision on it.
 *
 * `orders.status` has permitted `'returned'` since 0006 and nothing has ever
 * written it: there was no route a buyer could use and no queue a seller
 * reviewed. Underneath that, the refund engine could not have paid them anyway
 * — every row in `refunds` named a `customer_plan_id` and a `schedule_id`, both
 * NOT NULL, so it could only refund one instalment of one credit plan. An
 * outright purchase has neither. 0020 relaxed that; this is what uses it.
 *
 * Scope, stated plainly because it is a real limit and not an oversight:
 *
 *   * **A whole order at a time.** `order_items` has no status column, so an
 *     item-level return would leave the order saying `'returned'` while one
 *     shirt of three went back. Per-item returns need per-item state first.
 *   * **Outright purchases only.** A financed order's money has already been
 *     split across accruals, a reserve and a merchant payable, and unwinding
 *     that is `PayoutRecorder.reverseAccrualsForRefund` plus a plan the
 *     customer is still paying — a credit unwind, not a refund. Requesting one
 *     is refused with a reason rather than half-done.
 */
/**
 * The prefix every ledger transaction raised by an approved return carries.
 *
 * Exported, with its builder, for the same reason `ORDER_PAYMENT_TX_PREFIX` and
 * `PLAN_ACCRUAL_TX_PREFIX` are: the merchant order read has to find a return's
 * reversal again from SQL, and a second copy of the format in another file is a
 * rename waiting to go unnoticed.
 */
export const ORDER_RETURN_TX_PREFIX = 'order-return:';

export function orderReturnTransactionId(orderReturnId: string): string {
  return `${ORDER_RETURN_TX_PREFIX}${orderReturnId}`;
}

export class ReturnsService {
  constructor(
    private readonly db: Database,
    private readonly ledger: LedgerService,
    private readonly audit: AuditLogger,
    private readonly inventory: InventoryService,
    /**
     * Raises the customer's refund when a return is approved. Optional so the
     * read paths work without refund plumbing — but production must wire it, or
     * an approved return updates the books and nothing ever sends the money.
     */
    private readonly refunds?: ReturnRefundRecorder,
    /** Tells the buyer what was decided. Optional; a decision stands without it. */
    private readonly notifier?: ReturnDecisionNotifier,
  ) {}

  // ------------------------------------------------------------------ request

  /**
   * A buyer asks to send an order back.
   *
   * `customerId` scopes it inside the same transaction as the lock, so another
   * customer's order answers "not found" rather than confirming it exists.
   */
  async request(
    customerId: string,
    orderId: string,
    rawInput: unknown,
    now: Date = new Date(),
  ): Promise<OrderReturn> {
    const input: RequestReturnInput = requestReturnSchema.parse(rawInput);

    return runInTransaction(this.db, async (tx) => {
      const order = await this.lockOrder(tx, orderId, { customerId });

      if (order.payment_type !== 'full') {
        throw new OrderNotReturnableError(
          orderId,
          'an instalment order has to be unwound with its credit plan, which is not this flow',
        );
      }
      if (!RETURNABLE_STATUSES.includes(order.status as OrderStatus)) {
        throw new OrderNotReturnableError(orderId, `it is "${order.status}"`);
      }
      // The window is only meaningful once the goods have arrived. Before that
      // there is nothing to have kept too long.
      if (order.return_window_ends_at && order.return_window_ends_at < now.toISOString()) {
        throw new ReturnWindowClosedError(orderId, order.return_window_ends_at);
      }

      const open = await tx
        .select({ id: ret.id })
        .from(ret)
        .where(and(eq(ret.order_id, orderId), eq(ret.status, 'requested')))
        .limit(1);
      if (open[0]) throw new ReturnAlreadyOpenError(orderId);

      const rows = await tx
        .insert(ret)
        .values({
          order_id: orderId,
          customer_id: order.customer_id,
          reason: input.reason,
          // Fixed now, from the order as it stands. A decision has to be about
          // a known amount, and the order's total is not immutable.
          refund_amount_pesewas: order.total_pesewas,
          requested_at: now.toISOString(),
        })
        .returning();
      const row = rows[0]!;

      await this.audit.append(tx, {
        entityType: 'order',
        entityId: orderId,
        eventType: 'order.return_requested',
        actorId: customerId,
        actorType: 'customer',
        reason: input.reason,
        metadata: { order_return_id: row.id, amount_pesewas: row.refund_amount_pesewas },
      });

      // On the buyer's own timeline, so the app shows it beside the delivery.
      await this.recordEvent(tx, orderId, {
        eventType: 'order.return_requested',
        label: 'Return requested',
        detail: 'The seller will review it.',
        occurredAt: now,
      });

      return row;
    });
  }

  // ------------------------------------------------------------------ decide

  /**
   * The seller says yes: the order goes back, the stock goes back on sale, the
   * books are reversed and the buyer is owed their money.
   *
   * All of it in one transaction. A world where the order says `returned` and
   * nobody is on the hook for the refund is the one state this must not be able
   * to produce.
   */
  async approve(
    returnId: string,
    actor: ReturnActor,
    scope: ReturnScope = {},
    now: Date = new Date(),
  ): Promise<OrderReturn> {
    const decided = await runInTransaction(this.db, async (tx) => {
      const row = await this.lockOpenReturn(tx, returnId);
      const order = await this.lockOrder(tx, row.order_id, scope);

      assertOrderTransition(order.status as OrderStatus, 'returned');

      // 1. The order is no longer a sale.
      const updatedOrders = await tx
        .update(o)
        .set({ status: 'returned', updated_at: now.toISOString() })
        .where(and(eq(o.id, order.id), eq(o.status, order.status)))
        .returning();
      if (!updatedOrders[0]) {
        throw new OrderNotReturnableError(order.id, 'it changed under the decision');
      }

      // 2. The goods are sellable again. `commit` dropped them from reserved
      //    without returning them to available when the order was paid, so this
      //    is an increase to on-hand rather than a release of a reservation.
      const items = await tx.select().from(oi).where(eq(oi.order_id, order.id));
      for (const item of items) {
        if (!item.variant_id) continue;
        await this.inventory.restock(item.variant_id, item.quantity, tx);
      }

      // 3. The books.
      //
      //    The original payment booked cash in, the merchant's net and the
      //    platform's commission. Approving a return withdraws the two credits
      //    and creates an obligation to the buyer — it does NOT move cash,
      //    because no money has gone anywhere yet:
      //
      //      DEBIT  merchant_payable[merchant]  net        (no longer owed them)
      //      DEBIT  revenue[platform]           commission (not earned)
      //      CREDIT refund_payable[return]      total      (owed to the buyer)
      //
      //    Balanced by construction: net + commission = total. The cash leg
      //    comes later, when `RefundService.confirmRefund` books
      //    `refund-paid:{reference}` — DEBIT refund_payable, CREDIT
      //    paystack_settlement — against the very balance credited here, which
      //    is why the account ref is the return's id on both sides.
      const total = order.total_pesewas;
      const commission = Money.fromPesewas(total).multiplyBps(order.commission_bps).toNumber();
      const merchantNet = total - commission;
      const transactionId = orderReturnTransactionId(row.id);
      const metadata = {
        order_id: order.id,
        order_number: order.order_number,
        order_return_id: row.id,
      };
      const entries: LedgerEntryInput[] = [
        {
          transactionId,
          accountType: 'refund_payable' as const,
          accountRef: row.id,
          direction: 'credit' as const,
          amountPesewas: total,
          description: `Owed to the buyer for returned order ${order.order_number}`,
          metadata,
        },
        {
          transactionId,
          accountType: 'merchant_payable' as const,
          accountRef: order.merchant_id,
          direction: 'debit' as const,
          amountPesewas: merchantNet,
          description: `Merchant payable reversed for returned order ${order.order_number}`,
          metadata,
        },
        {
          transactionId,
          accountType: 'revenue' as const,
          accountRef: PLATFORM_ACCOUNT_REF,
          direction: 'debit' as const,
          amountPesewas: commission,
          description: `Commission reversed on returned order ${order.order_number}`,
          metadata,
        },
      ].filter((e) => e.amountPesewas > 0); // the ledger rejects 0-amount rows
      await this.ledger.record(entries, tx);

      // 4. The obligation to actually pay the buyer. Commits with everything
      //    else, so there is no window in which the order is returned and the
      //    refund does not exist.
      await this.refunds?.recordOrderReturnIntent(
        { orderReturnId: row.id, orderId: order.id, amountPesewas: row.refund_amount_pesewas },
        tx,
      );

      const updated = await tx
        .update(ret)
        .set({
          status: 'approved',
          decided_by: reviewerId(actor),
          decided_at: now.toISOString(),
        })
        .where(and(eq(ret.id, row.id), eq(ret.status, 'requested')))
        .returning();

      await this.audit.append(tx, {
        entityType: 'order',
        entityId: order.id,
        eventType: 'order.return_approved',
        fromState: order.status,
        toState: 'returned',
        actorId: actor.actorId,
        actorType: actor.actorType,
        metadata: {
          ...metadata,
          amount_pesewas: row.refund_amount_pesewas,
          merchant_net_reversed_pesewas: merchantNet,
          commission_reversed_pesewas: commission,
        },
      });

      await this.recordEvent(tx, order.id, {
        eventType: 'order.return_approved',
        label: 'Return approved',
        detail: `${Money.fromPesewas(row.refund_amount_pesewas).format()} is on its way back to you.`,
        occurredAt: now,
      });

      return { row: updated[0]!, order };
    });

    await this.announce(decided.row, decided.order, 'Return approved', {
      detail: `${Money.fromPesewas(decided.row.refund_amount_pesewas).format()} is on its way back to you.`,
    });
    return decided.row;
  }

  /** The seller says no, and has to say why. */
  async reject(
    returnId: string,
    rawInput: unknown,
    actor: ReturnActor,
    scope: ReturnScope = {},
    now: Date = new Date(),
  ): Promise<OrderReturn> {
    const input: RejectReturnInput = rejectReturnSchema.parse(rawInput);

    const decided = await runInTransaction(this.db, async (tx) => {
      const row = await this.lockOpenReturn(tx, returnId);
      const order = await this.lockOrder(tx, row.order_id, scope);

      const updated = await tx
        .update(ret)
        .set({
          status: 'rejected',
          decision_note: input.decision_note,
          decided_by: reviewerId(actor),
          decided_at: now.toISOString(),
        })
        .where(and(eq(ret.id, row.id), eq(ret.status, 'requested')))
        .returning();

      // The order is untouched: it was a completed sale before the request and
      // it still is. Nothing about the books changes on a refusal.
      await this.audit.append(tx, {
        entityType: 'order',
        entityId: order.id,
        eventType: 'order.return_rejected',
        actorId: actor.actorId,
        actorType: actor.actorType,
        reason: input.decision_note,
        metadata: { order_return_id: row.id },
      });

      await this.recordEvent(tx, order.id, {
        eventType: 'order.return_rejected',
        label: 'Return declined',
        detail: input.decision_note,
        occurredAt: now,
      });

      return { row: updated[0]!, order };
    });

    await this.announce(decided.row, decided.order, 'Return declined', {
      detail: input.decision_note,
    });
    return decided.row;
  }

  // -------------------------------------------------------------------- reads

  async listForCustomer(customerId: string, rawInput: unknown = {}): Promise<OrderReturn[]> {
    const input: ListReturnsInput = listReturnsSchema.parse(rawInput);
    const filters = [eq(ret.customer_id, customerId)];
    if (input.status) filters.push(eq(ret.status, input.status));
    return this.db
      .select()
      .from(ret)
      .where(and(...filters))
      .orderBy(desc(ret.requested_at))
      .limit(input.limit)
      .offset(input.offset);
  }

  /**
   * The queue a seller or an admin works from. Scoped by merchant through a
   * join on the order, so a merchant sees only returns against their own sales.
   */
  async list(rawInput: unknown = {}, scope: ReturnScope = {}): Promise<OrderReturn[]> {
    const input: ListReturnsInput = listReturnsSchema.parse(rawInput);
    const filters = [];
    if (input.status) filters.push(eq(ret.status, input.status));
    if (scope.merchantId) filters.push(eq(o.merchant_id, scope.merchantId));

    const rows = await this.db
      .select({ r: ret })
      .from(ret)
      .innerJoin(o, eq(o.id, ret.order_id))
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(ret.requested_at))
      .limit(input.limit)
      .offset(input.offset);
    return rows.map((row) => row.r);
  }

  async get(returnId: string, scope: ReturnScope = {}): Promise<OrderReturn> {
    const filters = [eq(ret.id, returnId)];
    if (scope.customerId) filters.push(eq(ret.customer_id, scope.customerId));
    const rows = await this.db
      .select({ r: ret })
      .from(ret)
      .innerJoin(o, eq(o.id, ret.order_id))
      .where(and(...filters, ...(scope.merchantId ? [eq(o.merchant_id, scope.merchantId)] : [])))
      .limit(1);
    const row = rows[0]?.r;
    if (!row) throw new ReturnNotFoundError(returnId);
    return row;
  }

  // ------------------------------------------------------------------ helpers

  private async lockOrder(
    tx: Parameters<Parameters<typeof runInTransaction>[1]>[0],
    orderId: string,
    scope: ReturnScope,
  ) {
    const rows = await tx
      .select()
      .from(o)
      .where(
        and(
          eq(o.id, orderId),
          ...(scope.customerId ? [eq(o.customer_id, scope.customerId)] : []),
          ...(scope.merchantId ? [eq(o.merchant_id, scope.merchantId)] : []),
        ),
      )
      .for('update')
      .limit(1);
    const row = rows[0];
    // A foreign order reads as one that does not exist — a 404, never a 403,
    // for the same reason as everywhere else on the scoped surface.
    if (!row) throw new OrderNotReturnableError(orderId, 'not found');
    return row;
  }

  private async lockOpenReturn(
    tx: Parameters<Parameters<typeof runInTransaction>[1]>[0],
    returnId: string,
  ): Promise<OrderReturn> {
    const rows = await tx.select().from(ret).where(eq(ret.id, returnId)).for('update').limit(1);
    const row = rows[0];
    if (!row) throw new ReturnNotFoundError(returnId);
    if (row.status !== 'requested') throw new ReturnAlreadyDecidedError(returnId, row.status);
    return row;
  }

  private async recordEvent(
    tx: Parameters<Parameters<typeof runInTransaction>[1]>[0],
    orderId: string,
    event: { eventType: string; label: string; detail?: string | null; occurredAt: Date },
  ): Promise<void> {
    await tx.insert(oe).values({
      order_id: orderId,
      event_type: event.eventType,
      label: event.label,
      detail: event.detail ?? null,
      occurred_at: event.occurredAt.toISOString(),
    });
  }

  /**
   * Tells the buyer, after the transaction and swallowed.
   *
   * A decision that has been taken and booked must not be undone by a push
   * provider being unreachable, and `order_events` already holds the record.
   */
  private async announce(
    row: OrderReturn,
    order: { id: string; order_number: string },
    title: string,
    copy: { detail: string },
  ): Promise<void> {
    if (!this.notifier) return;
    try {
      await this.notifier.notifyCustomerOfOrderEvent({
        customerId: row.customer_id,
        orderId: order.id,
        orderNumber: order.order_number,
        eventType: `order.return_${row.status}`,
        title,
        body: copy.detail,
      });
    } catch {
      // Recorded by the notifier where it could be.
    }
  }
}

/**
 * The reviewer to record, or null.
 *
 * `decided_by` is a foreign key into `users`, and only a person has a row there:
 * `actorOf` maps admin and agent staff to `'admin'`, a merchant's actor id is
 * their merchant id, and a worker's is a `SYSTEM_ACTORS` constant. The audit
 * event records the actor either way — this column is the console's shortcut,
 * not the record.
 */
function reviewerId(actor: ReturnActor): string | null {
  return actor.actorType === 'admin' ? actor.actorId : null;
}
