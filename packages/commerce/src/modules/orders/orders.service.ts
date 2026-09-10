import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, lte, sql } from 'drizzle-orm';
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
import {
  type DeliverySnapshot,
  cancelOrderSchema,
  checkoutSchema,
  confirmOrderPaymentSchema,
} from './dto';
import {
  AddressNotFoundError,
  EmptyCartError,
  NotPurchasableError,
  OrderNotActivatableError,
  OrderNotFoundError,
  OrderNotPayableError,
  OrderNotCancellableError,
  PickupHubNotFoundError,
} from './errors';
import { assertOrderTransition, type OrderStatus } from './order-state';
import { FulfilmentService } from '../fulfilment/fulfilment.service';

const o = schema.orders;
const oi = schema.order_items;
const carts = schema.carts;
const ci = schema.cart_items;
const pv = schema.product_variants;
const p = schema.products;
const addresses = schema.addresses;
const cp = schema.customer_plans;
const ap = schema.applications;
const oe = schema.order_events;
const hubs = schema.pickup_hubs;
const merch = schema.merchants;
const st = schema.stores;

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

/**
 * The ledger transaction that books an outright payment for one order.
 *
 * Exported — prefix and builder both — because the merchant stats read has to
 * find these rows again from SQL, and a second copy of the string in another
 * module is a rename waiting to go unnoticed. `confirmPayment` is the only
 * writer.
 */
export const ORDER_PAYMENT_TX_PREFIX = 'order-payment:';

export function orderPaymentTransactionId(orderId: string): string {
  return `${ORDER_PAYMENT_TX_PREFIX}${orderId}`;
}

/**
 * The slice of the push notifier this service needs.
 *
 * A narrow port rather than importing `PushNotifier`, for the same reason
 * `PayoutTransferClient` is one in core: commerce says what it requires and the
 * real notifier satisfies it structurally, so the fixtures hand over a plain
 * object and nothing here depends on a transport.
 */
export interface MerchantOrderNotifier {
  notifyMerchantOfOrder(args: {
    merchantId: string;
    orderId: string;
    orderNumber: string;
    itemSummary: string;
    totalGhs: string;
  }): Promise<unknown>;
}

export class OrdersService {
  constructor(
    private readonly db: Database,
    private readonly inventory: InventoryService,
    private readonly applications: ApplicationsService,
    private readonly plans: CustomerPlansService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditLogger,
    /**
     * Prices delivery and records the customer-facing lifecycle. Optional so
     * framework-free callers and existing tests can construct the service
     * without fulfilment plumbing; without it every order ships free.
     */
    private readonly fulfilment: FulfilmentService = new FulfilmentService(db),
    /**
     * Tells the seller an order is waiting on them. Optional for the same
     * reason `fulfilment` is — framework-free callers and the fixtures that
     * predate it construct the service without one — and when it is absent
     * nothing is announced, exactly as before.
     */
    private readonly merchantNotifier?: MerchantOrderNotifier,
  ) {}

  /**
   * Announce a placed order to its seller, after the transaction that placed it.
   *
   * After, not inside: a push about an order that then rolls back is a
   * notification about something that never happened, and holding a database
   * connection open across a call to Expo is how a slow provider becomes a
   * connection-pool outage. Swallows everything for the same reason the SMS
   * notifier does — the order is already placed and paid for, and a provider
   * being down must not turn that into an error the customer sees.
   */
  private async announceToMerchant(order: OrderWithItems): Promise<void> {
    if (!this.merchantNotifier) return;
    try {
      const first = order.items[0];
      const extra = order.items.length - 1;
      await this.merchantNotifier.notifyMerchantOfOrder({
        merchantId: order.merchant_id,
        orderId: order.id,
        orderNumber: order.order_number,
        itemSummary: first
          ? `${first.title}${extra > 0 ? ` and ${extra} more item${extra > 1 ? 's' : ''}` : ''}`
          : order.order_number,
        totalGhs: Money.fromPesewas(order.total_pesewas).format(),
      });
    } catch {
      // Nothing to do and nowhere useful to say it: the notifier already
      // records every attempt on `notifications`, which is the audit trail for
      // a message that did not arrive.
    }
  }

  /**
   * Appends to the order's customer-facing history.
   *
   * Separate from `audit.append` on purpose: the audit trail carries actor ids
   * and internal reasons that a shopper must not see, so the tracking screen
   * reads its own table rather than a filtered view of the audit log.
   */
  private async recordEvent(
    tx: Pick<Database, 'insert'>,
    orderId: string,
    event: {
      eventType: string;
      status?: string | null;
      label: string;
      detail?: string | null;
      occurredAt?: Date;
    },
  ): Promise<void> {
    await tx.insert(oe).values({
      order_id: orderId,
      event_type: event.eventType,
      status: event.status ?? null,
      label: event.label,
      detail: event.detail ?? null,
      occurred_at: (event.occurredAt ?? new Date()).toISOString(),
    });
  }

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
          store_status: st.status,
          store_deleted: st.deleted_at,
          merchant_status: merch.status,
          merchant_deleted: merch.deleted_at,
        })
        .from(ci)
        .innerJoin(pv, eq(pv.id, ci.variant_id))
        .innerJoin(p, eq(p.id, pv.product_id))
        .innerJoin(st, eq(st.id, p.store_id))
        .innerJoin(merch, eq(merch.id, p.merchant_id))
        .where(eq(ci.cart_id, cart.id))
        .orderBy(ci.created_at);
      if (lines.length === 0) throw new EmptyCartError();

      /**
       * Re-check purchasability at checkout time — the catalog may have changed
       * since the items were added. Prices honour the cart-line snapshot.
       *
       * The seller is checked as well as the goods, and that is the point of
       * this block. Suspending a merchant wrote `merchants.status` and nothing
       * else: their store stayed `active`, the storefront kept listing them,
       * and this loop asked only about the variant and the product — so a
       * merchant suspended for fraud went on taking orders. Verified before the
       * fix by suspending one and checking out a GHS 1,200 order against them.
       */
      for (const l of lines) {
        if (!l.variant_active || l.product_status !== 'active' || l.product_deleted) {
          throw new NotPurchasableError(`Variant "${l.variant_id}" is no longer purchasable`);
        }
        if (l.store_status !== 'active' || l.store_deleted) {
          throw new NotPurchasableError(`Store "${l.store_id}" is not open for orders`);
        }
        if (l.merchant_status !== 'active' || l.merchant_deleted) {
          throw new NotPurchasableError(`Seller of "${l.title}" is not currently trading`);
        }
      }

      /**
       * The delivery address, verified and then KEPT.
       *
       * This already loaded the row to prove the address is the caller's; it
       * selected only the id and threw the rest away. Holding it is what lets
       * the order carry its own copy — see `delivery_address` on the insert
       * below and migration 0022 for why an order must not read a live
       * address row it does not own.
       */
      let deliverySnapshot: DeliverySnapshot | null = null;
      if (input.shipping_address_id) {
        const addr = (
          await tx
            .select({
              id: addresses.id,
              recipient: addresses.recipient,
              phone: addresses.phone,
              region: addresses.region,
              city: addresses.city,
              area: addresses.area,
              landmark: addresses.landmark,
              ghanapost_gps: addresses.ghanapost_gps,
            })
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
        const { id: _id, ...snapshot } = addr;
        deliverySnapshot = snapshot;
      }

      if (input.fulfilment_method === 'pickup') {
        const hubRows = await tx
          .select({ id: hubs.id })
          .from(hubs)
          .where(and(eq(hubs.id, input.pickup_hub_id!), eq(hubs.is_active, true)))
          .limit(1);
        if (!hubRows[0]) throw new PickupHubNotFoundError(input.pickup_hub_id!);
      }

      // Price delivery once for the whole checkout, then charge it per order.
      //
      // A basket split across three stores is three deliveries, and pretending
      // otherwise would have the marketplace absorb the difference silently.
      // Charging the quote per order is the honest reading of "one order per
      // store", and it is what the merchant settlement maths already assumes.
      //
      // Delivery is only charged when there is somewhere to deliver to. Without
      // an address the zone lookup falls through to the national rate, so a
      // checkout that names no destination would be billed for a delivery
      // nobody can make — and `shipping_address_id` has always been optional.
      const shippingPerOrder =
        input.fulfilment_method === 'pickup' || !input.shipping_address_id
          ? 0
          : (await this.fulfilment.deliveryQuote({ address_id: input.shipping_address_id }, now))
              .fee_pesewas;

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
        const total = subtotal + shippingPerOrder;

        const [order] = await tx
          .insert(o)
          .values({
            order_number: generateOrderNumber(now),
            customer_id: customerId,
            merchant_id: merchantId,
            store_id: storeId,
            payment_type: input.payment_type,
            subtotal_pesewas: subtotal,
            shipping_pesewas: shippingPerOrder,
            total_pesewas: total,
            commission_bps: commissionBps,
            status,
            fulfilment_method: input.fulfilment_method,
            pickup_hub_id: input.pickup_hub_id ?? null,
            ...(input.shipping_address_id
              ? { shipping_address_id: input.shipping_address_id }
              : {}),
            // The address as it stood right now. `shipping_address_id` stays
            // as the pointer for anything that wants the live row; this is the
            // historical fact, and the two are allowed to diverge the moment
            // the shopper edits their address book.
            delivery_address: deliverySnapshot,
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

        await this.recordEvent(tx, order.id, {
          eventType: 'order.created',
          status,
          label: 'Order placed',
          detail:
            input.payment_type === 'installment'
              ? 'Checking your instalment plan'
              : 'Waiting for your payment',
          occurredAt: now,
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

    const paid = await runInTransaction(this.db, async (tx) => {
      const order = await this.lockOrder(tx, orderId);
      if (order.payment_type !== 'full' || order.status !== 'pending_payment') {
        throw new OrderNotPayableError(orderId, order.status);
      }
      assertOrderTransition('pending_payment', 'paid');

      const total = order.total_pesewas;
      const commission = Money.fromPesewas(total).multiplyBps(order.commission_bps).toNumber();
      const merchantNet = total - commission;
      const transactionId = orderPaymentTransactionId(order.id);
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
        .set({
          status: 'paid',
          placed_at: now.toISOString(),
          // The reference this order settled under, in the column meant to hold
          // it. `OrderPaymentService` writes it on the MoMo and card paths and
          // this one never did — it took the reference, put it in the audit row
          // and the ledger metadata, and left the column null. That was
          // invisible until a refund needed it: `refunds` classifies a row
          // without a provider reference as `manual`, so refunding a returned
          // order that Paystack had settled would have been parked for somebody
          // to send by hand.
          payment_reference: provider_reference,
        })
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

      await this.recordEvent(tx, order.id, {
        eventType: 'order.paid',
        status: 'paid',
        label: 'Payment received',
        detail: 'The seller can start preparing your order.',
        occurredAt: now,
      });

      return { ...updated, items };
    });

    await this.announceToMerchant(paid);
    return paid;
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

      await this.recordEvent(tx, order.id, {
        eventType: 'order.cancelled',
        status: 'cancelled',
        label: 'Order cancelled',
        detail: reason ?? 'Nothing was charged and the items are back on sale.',
        occurredAt: now,
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

      await this.recordEvent(tx, order.id, {
        eventType: 'order.declined',
        status: 'declined',
        label: 'Instalment plan declined',
        detail: 'The items have gone back on sale and nothing was charged.',
        occurredAt: now,
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

    const financed = await runInTransaction(this.db, async (tx) => {
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

      await this.recordEvent(tx, orderId, {
        eventType: 'order.financing_activated',
        status: 'financing_active',
        label: 'Instalment plan approved',
        detail: 'Your schedule is ready — pay the deposit to confirm the order.',
        occurredAt: now,
      });

      return { ...updated, items };
    });

    // The BNPL half of the same moment: the plan is live, so the order is the
    // seller's to pack even though the customer has only paid a deposit.
    await this.announceToMerchant(financed);
    return financed;
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

  /**
   * A merchant's own orders, newest first.
   *
   * The fulfilment endpoints added in #41 let a merchant ship and deliver, but
   * nothing let them SEE what they had sold — so the loop was only reachable by
   * someone who already knew an order's uuid. This is the read half.
   *
   * `merchant_id` is always in the WHERE clause rather than checked after the
   * fact, so another merchant's order is indistinguishable from one that does
   * not exist. That is the same rule the rest of the scoped surface follows.
   */
  async listForMerchant(
    merchantId: string,
    opts: { status?: string; limit?: number; offset?: number } = {},
  ): Promise<{ rows: OrderWithItems[]; total: number }> {
    const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
    const offset = Math.max(opts.offset ?? 0, 0);
    const where = opts.status
      ? and(eq(o.merchant_id, merchantId), eq(o.status, opts.status))
      : eq(o.merchant_id, merchantId);

    const [{ count } = { count: 0 }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(o)
      .where(where);

    const rows = await this.db
      .select()
      .from(o)
      .where(where)
      .orderBy(desc(o.created_at))
      .limit(limit)
      .offset(offset);
    if (rows.length === 0) return { rows: [], total: count };

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
    return {
      rows: rows.map((order) => ({ ...order, items: byOrder.get(order.id) ?? [] })),
      total: count,
    };
  }

  /** One of a merchant's own orders. Scoped the same way as the list. */
  async getForMerchant(merchantId: string, orderId: string): Promise<OrderWithItems> {
    const [order] = await this.db
      .select()
      .from(o)
      .where(and(eq(o.id, orderId), eq(o.merchant_id, merchantId)))
      .limit(1);
    if (!order) throw new OrderNotFoundError(orderId);

    const items = await this.db
      .select()
      .from(oi)
      .where(eq(oi.order_id, orderId))
      .orderBy(oi.created_at);
    return { ...order, items };
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
