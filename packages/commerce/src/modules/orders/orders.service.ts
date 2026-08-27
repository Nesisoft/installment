import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, lte } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import {
  AuditLogger,
  ApplicationsService,
  CustomerPlansService,
  LedgerService,
  Money,
  PLATFORM_ACCOUNT_REF,
  PlanAlreadyActiveError,
  SETTLEMENT_CASH_REF,
  runInTransaction,
  type LedgerEntryInput,
  type PlanActor,
  type TransactionalTx,
  SYSTEM_ACTORS,
} from '@installment/core';
import { InventoryService } from '../catalog/inventory.service';
import { cancelOrderSchema, checkoutSchema, confirmOrderPaymentSchema } from './dto';
import {
  AddressNotFoundError,
  EmptyCartError,
  NotPurchasableError,
  OrderNotActivatableError,
  OrderNotFoundError,
  OrderNotPayableError,
  OrderNotCancellableError,
} from './errors';
import { assertOrderTransition, type OrderStatus } from './order-state';

const o = schema.orders;
const oi = schema.order_items;
const carts = schema.carts;
const ci = schema.cart_items;
const pv = schema.product_variants;
const p = schema.products;
const addresses = schema.addresses;
const cp = schema.customer_plans;
const ap = schema.applications;

export type Order = typeof schema.orders.$inferSelect;
export type OrderItem = typeof schema.order_items.$inferSelect;

export interface OrderWithItems extends Order {
  items: OrderItem[];
}

/**
 * Default marketplace take-rate applied to pay-now (full) orders, in basis
 * points (500 = 5%). Installment orders carry a 0 rate here: the engine already
 * takes its cut through the plan's MDR/reserve accrual (see PayoutRecorder), so
 * layering a second commission would double-charge the merchant.
 */
export const DEFAULT_MARKETPLACE_COMMISSION_BPS = 500;

/**
 * Category label handed to the engine on an installment application. Deriving it
 * from the catalog (product category → scoring eligibility) is a later
 * refinement; a non-empty default keeps the hand-off honest for now.
 */
export const DEFAULT_MERCHANT_CATEGORY = 'general';

/**
 * Checkout & orders — the commerce layer that sits on the installment engine.
 *
 * `checkout` turns the customer's active cart into one order per store (a
 * multi-vendor cart splits), snapshots the lines, reserves stock, and either
 * leaves the order awaiting payment (full) or hands it to the engine as an
 * application whose `order_reference` is the order's own id (installment).
 * `confirmPayment` settles a full order and books the marketplace commission
 * split into the ledger; `activateFinancing` turns an approved application into
 * an active plan and advances the order. Every write is audited.
 */
/**
 * The states a cancel can act on: everything before the customer's money moves.
 * `paid` and `financing_active` are cancellable per ORDER_TRANSITIONS but need a
 * refund or a plan unwind, which is the refunds module's job.
 */
/** How long an unpaid order may hold its stock before the sweep takes it back. */
const DEFAULT_PAYMENT_TTL_HOURS = 24;
/** Bounds one sweep so a large backlog is worked through over several runs. */
const DEFAULT_SWEEP_LIMIT = 500;
/** Application states from which an order can never become financing_active. */
const TERMINAL_APPLICATION_STATUSES = ['expired', 'declined', 'cancelled'];

const CANCELLABLE_STATUSES: readonly OrderStatus[] = [
  'pending_payment',
  'pending_approval',
  'payment_failed',
];

export class OrdersService {
  constructor(
    private readonly db: Database,
    private readonly inventory: InventoryService,
    private readonly applications: ApplicationsService,
    private readonly plans: CustomerPlansService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditLogger,
  ) {}

  /**
   * Converts the customer's active cart into orders (one per store). Runs in a
   * single transaction: orders + items + stock reservation + the engine
   * hand-off + cart conversion all commit together or not at all.
   */
  async checkout(
    customerId: string,
    rawInput: unknown,
    actor: PlanActor,
    now: Date = new Date(),
  ): Promise<OrderWithItems[]> {
    const input = checkoutSchema.parse(rawInput);

    return runInTransaction(this.db, async (tx) => {
      // Lock the active cart so a concurrent checkout can't double-spend it.
      const cart = (
        await tx
          .select()
          .from(carts)
          .where(and(eq(carts.customer_id, customerId), eq(carts.status, 'active')))
          .for('update')
          .limit(1)
      )[0];
      if (!cart) throw new EmptyCartError();

      const lines = await tx
        .select({
          variant_id: ci.variant_id,
          quantity: ci.quantity,
          unit_price_pesewas: ci.unit_price_pesewas,
          sku: pv.sku,
          variant_active: pv.is_active,
          product_id: p.id,
          title: p.title,
          store_id: p.store_id,
          merchant_id: p.merchant_id,
          product_status: p.status,
          product_deleted: p.deleted_at,
        })
        .from(ci)
        .innerJoin(pv, eq(pv.id, ci.variant_id))
        .innerJoin(p, eq(p.id, pv.product_id))
        .where(eq(ci.cart_id, cart.id))
        .orderBy(ci.created_at);
      if (lines.length === 0) throw new EmptyCartError();

      // Re-check purchasability at checkout time — the catalog may have changed
      // since the items were added. Prices honour the cart-line snapshot.
      for (const l of lines) {
        if (!l.variant_active || l.product_status !== 'active' || l.product_deleted) {
          throw new NotPurchasableError(`Variant "${l.variant_id}" is no longer purchasable`);
        }
      }

      if (input.shipping_address_id) {
        const addr = (
          await tx
            .select({ id: addresses.id })
            .from(addresses)
            .where(
              and(
                eq(addresses.id, input.shipping_address_id),
                eq(addresses.customer_id, customerId),
              ),
            )
            .limit(1)
        )[0];
        if (!addr) throw new AddressNotFoundError(input.shipping_address_id);
      }

      // One order per store (a store belongs to exactly one merchant).
      const byStore = new Map<string, typeof lines>();
      for (const l of lines) {
        const bucket = byStore.get(l.store_id);
        if (bucket) bucket.push(l);
        else byStore.set(l.store_id, [l]);
      }

      const commissionBps = input.payment_type === 'full' ? DEFAULT_MARKETPLACE_COMMISSION_BPS : 0;
      const status: OrderStatus =
        input.payment_type === 'full' ? 'pending_payment' : 'pending_approval';

      const result: OrderWithItems[] = [];
      for (const group of byStore.values()) {
        const storeId = group[0]!.store_id;
        const merchantId = group[0]!.merchant_id;
        const subtotal = group.reduce((s, l) => s + l.unit_price_pesewas * l.quantity, 0);
        const total = subtotal; // shipping/discount are a later slice

        const [order] = await tx
          .insert(o)
          .values({
            order_number: generateOrderNumber(now),
            customer_id: customerId,
            merchant_id: merchantId,
            store_id: storeId,
            payment_type: input.payment_type,
            subtotal_pesewas: subtotal,
            total_pesewas: total,
            commission_bps: commissionBps,
            status,
            ...(input.shipping_address_id
              ? { shipping_address_id: input.shipping_address_id }
              : {}),
          })
          .returning();
        if (!order) throw new Error('orders insert returned no row');

        const items = await tx
          .insert(oi)
          .values(
            group.map((l) => ({
              order_id: order.id,
              variant_id: l.variant_id,
              product_id: l.product_id,
              title: l.title,
              sku: l.sku,
              quantity: l.quantity,
              unit_price_pesewas: l.unit_price_pesewas,
              line_total_pesewas: l.unit_price_pesewas * l.quantity,
            })),
          )
          .returning();

        // Reserve stock for every line — atomic with the order (same tx).
        for (const l of group) {
          await this.inventory.reserve(l.variant_id, l.quantity, tx);
        }

        // Installment: hand the order to the engine. order_reference = order.id
        // is the seam between commerce and the lender — the engine never learns
        // anything else about the order.
        let applicationId: string | null = null;
        if (input.payment_type === 'installment') {
          const application = await this.applications.submit(
            {
              customer_id: customerId,
              merchant_id: merchantId,
              plan_template_id: input.plan_template_id!,
              order_reference: order.id,
              order_amount_pesewas: total,
              merchant_category: DEFAULT_MERCHANT_CATEGORY,
            },
            actor,
            tx,
          );
          applicationId = application.id;
          await tx.update(o).set({ application_id: applicationId }).where(eq(o.id, order.id));
        }

        await this.audit.append(tx, {
          entityType: 'order',
          entityId: order.id,
          eventType: 'order.created',
          toState: status,
          actorId: actor.actorId,
          actorType: actor.actorType,
          metadata: {
            payment_type: input.payment_type,
            merchant_id: merchantId,
            store_id: storeId,
            total_pesewas: total,
            commission_bps: commissionBps,
            ...(applicationId ? { application_id: applicationId } : {}),
          },
        });

        result.push({ ...order, application_id: applicationId, items });
      }

      // Convert the cart so the next visit starts a fresh one.
      await tx.update(carts).set({ status: 'converted' }).where(eq(carts.id, cart.id));

      return result;
    });
  }

  /**
   * Settles a paid-now order once its charge clears (webhook / admin). Books the
   * marketplace commission split — cash in, merchant net + platform commission —
   * commits the reserved stock, and advances the order to `paid`. Idempotent on
   * the status guard.
   */
  async confirmPayment(
    orderId: string,
    rawInput: unknown,
    actor: PlanActor,
    now: Date = new Date(),
  ): Promise<OrderWithItems> {
    const { provider_reference } = confirmOrderPaymentSchema.parse(rawInput);

    return runInTransaction(this.db, async (tx) => {
      const order = await this.lockOrder(tx, orderId);
      if (order.payment_type !== 'full' || order.status !== 'pending_payment') {
        throw new OrderNotPayableError(orderId, order.status);
      }
      assertOrderTransition('pending_payment', 'paid');

      const total = order.total_pesewas;
      const commission = Money.fromPesewas(total).multiplyBps(order.commission_bps).toNumber();
      const merchantNet = total - commission;
      const transactionId = `order-payment:${order.id}`;
      const metadata = {
        order_id: order.id,
        order_number: order.order_number,
        provider_reference,
      };
      const entries: LedgerEntryInput[] = [
        {
          transactionId,
          accountType: 'paystack_settlement' as const,
          accountRef: SETTLEMENT_CASH_REF,
          direction: 'debit' as const,
          amountPesewas: total,
          description: `Order ${order.order_number} paid`,
          metadata,
        },
        {
          transactionId,
          accountType: 'merchant_payable' as const,
          accountRef: order.merchant_id,
          direction: 'credit' as const,
          amountPesewas: merchantNet,
          description: `Merchant payable for order ${order.order_number}`,
          metadata,
        },
        {
          transactionId,
          accountType: 'revenue' as const,
          accountRef: PLATFORM_ACCOUNT_REF,
          direction: 'credit' as const,
          amountPesewas: commission,
          description: `Marketplace commission on order ${order.order_number}`,
          metadata,
        },
      ].filter((e) => e.amountPesewas > 0); // ledger rejects 0-amount rows
      await this.ledger.record(entries, tx);

      const items = await this.commitItems(tx, order.id);

      const [updated] = await tx
        .update(o)
        .set({ status: 'paid', placed_at: now.toISOString() })
        .where(and(eq(o.id, order.id), eq(o.status, 'pending_payment')))
        .returning();
      if (!updated) throw new OrderNotPayableError(orderId, order.status);

      await this.audit.append(tx, {
        entityType: 'order',
        entityId: order.id,
        eventType: 'order.paid',
        fromState: 'pending_payment',
        toState: 'paid',
        actorId: actor.actorId,
        actorType: actor.actorType,
        metadata: {
          provider_reference,
          total_pesewas: total,
          commission_pesewas: commission,
          merchant_net_pesewas: merchantNet,
        },
      });

      return { ...updated, items };
    });
  }

  /**
   * Cancels an order that has not yet taken the customer's money, and gives the
   * stock back.
   *
   * Checkout reserves every unit it is about to sell. Until now nothing ever
   * released a reservation — `InventoryService.release` existed, documented for
   * exactly this ("cancel / expiry"), with no caller anywhere — so an order the
   * customer walked away from held its units out of sellable stock permanently.
   *
   * Only the states before money moves are cancellable here. ORDER_TRANSITIONS
   * also permits `paid -> cancelled` and `financing_active -> cancelled`, but
   * neither is a status flip: one needs the ledger reversed and the customer
   * refunded, the other needs a live credit plan unwound. Those belong with the
   * refunds module, so this refuses them rather than cancelling an order while
   * quietly keeping the cash.
   *
   * `customerId` scopes the cancel to its owner. It is checked inside the same
   * transaction as the lock, so ownership cannot change under the request, and
   * a foreign id answers "not found" rather than confirming the order exists.
   */
  async cancel(
    orderId: string,
    rawInput: unknown,
    actor: PlanActor,
    opts: { customerId?: string } = {},
    now: Date = new Date(),
  ): Promise<OrderWithItems> {
    const { reason } = cancelOrderSchema.parse(rawInput);

    const cancelled = await runInTransaction(this.db, async (tx) => {
      const order = await this.lockOrder(tx, orderId);
      if (opts.customerId && order.customer_id !== opts.customerId) {
        throw new OrderNotFoundError(orderId);
      }
      if (!CANCELLABLE_STATUSES.includes(order.status as OrderStatus)) {
        throw new OrderNotCancellableError(orderId, order.status);
      }
      assertOrderTransition(order.status as OrderStatus, 'cancelled');

      // Hand every reserved unit back before the status flips, so a failure
      // anywhere here rolls the whole thing back rather than losing the stock.
      const items = await this.releaseItems(tx, order.id);

      const [updated] = await tx
        .update(o)
        .set({ status: 'cancelled', updated_at: now.toISOString() })
        .where(and(eq(o.id, order.id), eq(o.status, order.status)))
        .returning();
      if (!updated) throw new OrderNotCancellableError(orderId, order.status);

      await this.audit.append(tx, {
        entityType: 'order',
        entityId: order.id,
        eventType: 'order.cancelled',
        fromState: order.status,
        toState: 'cancelled',
        actorId: actor.actorId,
        actorType: actor.actorType,
        metadata: {
          ...(reason ? { reason } : {}),
          released_units: items.reduce((n, i) => n + (i.variant_id ? i.quantity : 0), 0),
        },
      });

      return { ...updated, items, application_id: order.application_id };
    });

    // The credit application lives in the engine and opens its own transaction,
    // so it cannot join the one above — the same constraint activateFinancing
    // documents. Cancel it after the order is safely cancelled: leaving it
    // pending would keep a dead application in the review queue. If this fails
    // the order stays cancelled and the stock stays released, which is the half
    // that matters; the stranded application cannot be activated because
    // activateFinancing refuses any order that is not pending_approval.
    if (cancelled.application_id) {
      await this.applications
        .cancel(cancelled.application_id, { actorId: actor.actorId, actorType: actor.actorType })
        .catch(() => undefined);
    }

    return cancelled;
  }

  /**
   * Cancels orders that are never going to be paid for, and gives their stock
   * back.
   *
   * `cancel` only helps when somebody asks. The ordinary case is that nobody
   * does: a shopper checks out, never pays, and never returns. Their units stay
   * reserved forever, so the catalogue slowly bleeds sellable stock to
   * abandoned baskets.
   *
   * Two kinds of order have stopped being live:
   *
   * - `pending_payment` older than `paymentTtlHours` — the customer had their
   *   chance to pay and did not take it.
   * - `pending_approval` whose credit application has reached a terminal state.
   *   ApplicationExpiryCron already expires stale applications hourly and an
   *   admin can decline one, but neither touches the ORDER: the application goes
   *   terminal and its order sits in `pending_approval` holding stock with
   *   nothing left that could ever approve it.
   *
   * Each order is cancelled on its own, so one failure cannot strand the rest of
   * the batch — a row that has moved on since it was selected simply loses its
   * status guard and is skipped.
   */
  async sweepAbandoned(
    now: Date = new Date(),
    opts: { paymentTtlHours?: number; limit?: number } = {},
  ): Promise<{
    checked: number;
    cancelled: number;
    releasedUnits: number;
    failed: number;
  }> {
    const ttlHours = opts.paymentTtlHours ?? DEFAULT_PAYMENT_TTL_HOURS;
    const limit = opts.limit ?? DEFAULT_SWEEP_LIMIT;
    const cutoff = new Date(now.getTime() - ttlHours * 60 * 60 * 1000).toISOString();
    const actor = { actorId: SYSTEM_ACTORS.SCHEDULER, actorType: 'worker' as const };

    const unpaid = await this.db
      .select({ id: o.id })
      .from(o)
      .where(and(eq(o.status, 'pending_payment'), lte(o.created_at, cutoff)))
      .limit(limit);

    // Financing that can no longer happen: the application is terminal, so the
    // order will never leave pending_approval on its own.
    const deadFinancing = await this.db
      .select({ id: o.id })
      .from(o)
      .innerJoin(ap, eq(ap.id, o.application_id))
      .where(
        and(eq(o.status, 'pending_approval'), inArray(ap.status, TERMINAL_APPLICATION_STATUSES)),
      )
      .limit(limit);

    const candidates = [...unpaid, ...deadFinancing];
    let cancelled = 0;
    let releasedUnits = 0;
    let failed = 0;

    for (const row of candidates) {
      try {
        const order = await this.cancel(row.id, { reason: 'Abandoned — swept' }, actor, {}, now);
        cancelled += 1;
        releasedUnits += order.items.reduce((n, i) => n + (i.variant_id ? i.quantity : 0), 0);
      } catch {
        // Raced with a real payment, a manual cancel, or an approval that landed
        // between the select and the update. Leave it be and keep sweeping.
        failed += 1;
      }
    }

    return { checked: candidates.length, cancelled, releasedUnits, failed };
  }

  /**
   * Closes an installment order whose credit application was declined, and
   * releases the stock it was holding.
   *
   * The mirror of {@link activateFinancing}. That one was wired from the
   * activation endpoint and this one never existed, so ORDER_TRANSITIONS
   * permitted `pending_approval -> declined` while nothing in the codebase ever
   * set an order to `declined`. A refused application left its order sitting in
   * `pending_approval` holding stock, and the customer looking at "financing
   * under review" for an answer that had already been given.
   *
   * Idempotent: an order already declined is returned as-is, so a retried
   * decision cannot try to release the same units twice.
   */
  async declineFinancing(
    orderId: string,
    actor: PlanActor,
    now: Date = new Date(),
  ): Promise<OrderWithItems> {
    return runInTransaction(this.db, async (tx) => {
      const order = await this.lockOrder(tx, orderId);
      if (order.status === 'declined') {
        return { ...order, items: await this.loadItems(tx, order.id) };
      }
      if (order.payment_type !== 'installment' || order.status !== 'pending_approval') {
        throw new OrderNotCancellableError(orderId, order.status);
      }
      assertOrderTransition('pending_approval', 'declined');

      const items = await this.releaseItems(tx, order.id);

      const [updated] = await tx
        .update(o)
        .set({ status: 'declined', updated_at: now.toISOString() })
        .where(and(eq(o.id, order.id), eq(o.status, 'pending_approval')))
        .returning();
      if (!updated) throw new OrderNotCancellableError(orderId, order.status);

      await this.audit.append(tx, {
        entityType: 'order',
        entityId: order.id,
        eventType: 'order.declined',
        fromState: 'pending_approval',
        toState: 'declined',
        actorId: actor.actorId,
        actorType: actor.actorType,
        metadata: {
          released_units: items.reduce((n, i) => n + (i.variant_id ? i.quantity : 0), 0),
        },
      });

      return { ...updated, items };
    });
  }

  /**
   * Turns an approved installment order into an active plan and advances it to
   * `financing_active`. Activation (engine) and the order link run in separate
   * transactions by necessity — activateFromApplication opens its own — so the
   * link step is written to be idempotent: a replay reuses the existing plan.
   */
  async activateFinancing(
    orderId: string,
    actor: PlanActor,
    now: Date = new Date(),
  ): Promise<OrderWithItems> {
    const order = await this.getOrderRow(orderId);
    if (order.payment_type !== 'installment' || !order.application_id) {
      throw new OrderNotActivatableError(orderId, `status ${order.status}`);
    }
    // Idempotent: already activated — return the order as-is.
    if (order.status === 'financing_active') {
      return this.get(order.customer_id, orderId);
    }
    if (order.status !== 'pending_approval') {
      throw new OrderNotActivatableError(orderId, `status ${order.status}`);
    }

    const application = await this.applications.get(order.application_id);
    if (application.status !== 'approved') {
      throw new OrderNotActivatableError(
        orderId,
        `application is "${application.status}", not approved`,
      );
    }

    // Activate the plan (engine, own transaction). On a replay the plan already
    // exists — reuse it rather than failing the whole activation.
    let planId: string;
    try {
      const activated = await this.plans.activateFromApplication(order.application_id, actor, now);
      planId = activated.plan.id;
    } catch (err) {
      if (!(err instanceof PlanAlreadyActiveError)) throw err;
      const existing = (
        await this.db
          .select({ id: cp.id })
          .from(cp)
          .where(eq(cp.application_id, order.application_id))
          .limit(1)
      )[0];
      if (!existing) throw err;
      planId = existing.id;
    }

    return runInTransaction(this.db, async (tx) => {
      const locked = await this.lockOrder(tx, orderId);
      if (locked.status === 'financing_active') {
        return { ...locked, items: await this.loadItems(tx, orderId) };
      }
      if (locked.status !== 'pending_approval') {
        throw new OrderNotActivatableError(orderId, `status ${locked.status}`);
      }
      assertOrderTransition('pending_approval', 'financing_active');

      const items = await this.commitItems(tx, orderId);
      const [updated] = await tx
        .update(o)
        .set({ status: 'financing_active', customer_plan_id: planId, placed_at: now.toISOString() })
        .where(and(eq(o.id, orderId), eq(o.status, 'pending_approval')))
        .returning();
      if (!updated) throw new OrderNotActivatableError(orderId, 'status changed concurrently');

      await this.audit.append(tx, {
        entityType: 'order',
        entityId: orderId,
        eventType: 'order.financing_activated',
        fromState: 'pending_approval',
        toState: 'financing_active',
        actorId: actor.actorId,
        actorType: actor.actorType,
        metadata: { customer_plan_id: planId, application_id: order.application_id },
      });

      return { ...updated, items };
    });
  }

  async get(customerId: string, orderId: string): Promise<OrderWithItems> {
    const order = (
      await this.db
        .select()
        .from(o)
        .where(and(eq(o.id, orderId), eq(o.customer_id, customerId)))
        .limit(1)
    )[0];
    if (!order) throw new OrderNotFoundError(orderId);
    const items = await this.db
      .select()
      .from(oi)
      .where(eq(oi.order_id, orderId))
      .orderBy(oi.created_at);
    return { ...order, items };
  }

  async listForCustomer(customerId: string): Promise<OrderWithItems[]> {
    const rows = await this.db
      .select()
      .from(o)
      .where(eq(o.customer_id, customerId))
      .orderBy(desc(o.created_at));
    if (rows.length === 0) return [];

    const items = await this.db
      .select()
      .from(oi)
      .where(
        inArray(
          oi.order_id,
          rows.map((r) => r.id),
        ),
      )
      .orderBy(oi.created_at);
    const byOrder = new Map<string, OrderItem[]>();
    for (const item of items) {
      const bucket = byOrder.get(item.order_id);
      if (bucket) bucket.push(item);
      else byOrder.set(item.order_id, [item]);
    }
    return rows.map((order) => ({ ...order, items: byOrder.get(order.id) ?? [] }));
  }

  // ------------------------------------------------------------- internal

  private async lockOrder(tx: TransactionalTx, orderId: string): Promise<Order> {
    const row = (await tx.select().from(o).where(eq(o.id, orderId)).for('update').limit(1))[0];
    if (!row) throw new OrderNotFoundError(orderId);
    return row;
  }

  /**
   * The order a given engine application belongs to, or null when the
   * application did not originate from a commerce checkout. Lets the admin
   * activation path route through {@link activateFinancing} (which links the
   * order) instead of activating the plan alone and leaving the order stranded
   * in `pending_approval`.
   */
  async findByApplication(applicationId: string): Promise<Order | null> {
    const row = (
      await this.db.select().from(o).where(eq(o.application_id, applicationId)).limit(1)
    )[0];
    return row ?? null;
  }

  private async getOrderRow(orderId: string): Promise<Order> {
    const row = (await this.db.select().from(o).where(eq(o.id, orderId)).limit(1))[0];
    if (!row) throw new OrderNotFoundError(orderId);
    return row;
  }

  private async loadItems(tx: TransactionalTx, orderId: string): Promise<OrderItem[]> {
    return tx.select().from(oi).where(eq(oi.order_id, orderId)).orderBy(oi.created_at);
  }

  /** Loads the order's items and hands each reservation back to available stock. */
  private async releaseItems(tx: TransactionalTx, orderId: string): Promise<OrderItem[]> {
    const items = await this.loadItems(tx, orderId);
    for (const item of items) {
      if (item.variant_id) await this.inventory.release(item.variant_id, item.quantity, tx);
    }
    return items;
  }

  /** Loads the order's items and finalises each reservation as sold. */
  private async commitItems(tx: TransactionalTx, orderId: string): Promise<OrderItem[]> {
    const items = await this.loadItems(tx, orderId);
    for (const item of items) {
      if (item.variant_id) await this.inventory.commit(item.variant_id, item.quantity, tx);
    }
    return items;
  }
}

/** `ORD-YYYYMMDD-XXXXXXXX` — the suffix keeps it unique within a day. */
function generateOrderNumber(now: Date): string {
  const day = now.toISOString().slice(0, 10).replace(/-/g, '');
  const suffix = randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
  return `ORD-${day}-${suffix}`;
}
