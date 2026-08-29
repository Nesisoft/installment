import { and, asc, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import {
  AuditLogger,
  CustomerPlansService,
  runInTransaction,
  type PlanActor,
  type TransactionalTx,
} from '@installment/core';
import { assertOrderTransition, type OrderStatus } from '../orders/order-state';
import { OrderNotFoundError, OrderNotFulfillableError } from '../orders/errors';
import type { Order } from '../orders/orders.service';
import {
  markDeliveredSchema,
  markOutForDeliverySchema,
  markShippedSchema,
  type MarkDeliveredInput,
  type MarkOutForDeliveryInput,
  type MarkShippedInput,
} from './dto';
import {
  deliveryQuoteSchema,
  listPickupHubsSchema,
  type DeliveryQuoteInput,
  type ListPickupHubsInput,
} from '../catalog/storefront.dto';
import { AddressNotFoundError, DeliveryZoneNotConfiguredError } from '../orders/errors';

const dz = schema.delivery_zones;
const hub = schema.pickup_hubs;
const addr = schema.addresses;
const oe = schema.order_events;
const ship = schema.shipments;
const ord = schema.orders;

export interface DeliveryQuote {
  fulfilment_method: 'courier';
  fee_pesewas: number;
  eta_min_days: number;
  eta_max_days: number;
  /** ISO dates bracketing the arrival window, so the client never does date maths. */
  eta_earliest: string;
  eta_latest: string;
  /** Which zone answered: 'city' | 'region' | 'national'. */
  matched: 'city' | 'region' | 'national';
}

export type PickupHub = typeof schema.pickup_hubs.$inferSelect;
export type OrderEvent = typeof schema.order_events.$inferSelect;
export type Shipment = typeof schema.shipments.$inferSelect;

export interface OrderTracking {
  order_id: string;
  order_number: string;
  status: string;
  fulfilment_method: 'courier' | 'pickup';
  pickup_hub: PickupHub | null;
  shipment: Shipment | null;
  delivered_at: string | null;
  return_window_ends_at: string | null;
  events: {
    event_type: string;
    status: string | null;
    label: string;
    detail: string | null;
    occurred_at: string;
  }[];
}

const MS_PER_DAY = 86_400_000;

/**
 * Fulfilment: what delivery costs, where it can be collected, and where an order
 * has got to.
 *
 * `orders.shipping_pesewas` existed from the first commerce migration and was
 * never written — every order totalled to its subtotal, and the "Delivery to
 * Osu · GHS 15" line in the design had nothing behind it. This is where that
 * number now comes from.
 */
export class FulfilmentService {
  constructor(
    private readonly db: Database,
    /**
     * Optional so the read paths (quotes, hubs, tracking) work without engine
     * plumbing — but production must wire both, or marking an order delivered
     * will not start the layaway reserve clock.
     */
    private readonly audit?: AuditLogger,
    private readonly plans?: CustomerPlansService,
  ) {}

  /**
   * What courier delivery costs to a place.
   *
   * Resolution is city → region → national, and the national row is seeded, so
   * a quote is always answerable. That matters: checkout cannot price an order
   * it has no delivery rate for, and refusing to quote would block a sale over
   * a place name we simply have not zoned yet.
   */
  async deliveryQuote(rawInput: unknown = {}, now: Date = new Date()): Promise<DeliveryQuote> {
    const input: DeliveryQuoteInput = deliveryQuoteSchema.parse(rawInput);

    let { region, city } = input;
    if (input.address_id) {
      const rows = await this.db
        .select({ region: addr.region, city: addr.city })
        .from(addr)
        .where(eq(addr.id, input.address_id))
        .limit(1);
      const address = rows[0];
      if (!address) throw new AddressNotFoundError(input.address_id);
      region = address.region;
      city = address.city;
    }

    const zones = await this.db.select().from(dz).where(eq(dz.is_active, true));

    const byCity = zones.find(
      (z) => z.city && city && eqi(z.city, city) && z.region && region && eqi(z.region, region),
    );
    const byRegion = zones.find((z) => !z.city && z.region && region && eqi(z.region, region));
    const national = zones.find((z) => !z.city && !z.region);

    const zone = byCity ?? byRegion ?? national;
    // The seed guarantees a national row; reaching here means it was removed,
    // which is an operational fault rather than a customer's problem.
    if (!zone) throw new DeliveryZoneNotConfiguredError();

    return {
      fulfilment_method: 'courier',
      fee_pesewas: zone.fee_pesewas,
      eta_min_days: zone.eta_min_days,
      eta_max_days: zone.eta_max_days,
      eta_earliest: isoDate(now, zone.eta_min_days),
      eta_latest: isoDate(now, zone.eta_max_days),
      matched: byCity ? 'city' : byRegion ? 'region' : 'national',
    };
  }

  async pickupHubs(rawInput: unknown = {}): Promise<PickupHub[]> {
    const input: ListPickupHubsInput = listPickupHubsSchema.parse(rawInput);
    const where = [eq(hub.is_active, true)];
    if (input.city) where.push(sql`LOWER(${hub.city}) = LOWER(${input.city})`);
    if (input.region) where.push(sql`LOWER(${hub.region}) = LOWER(${input.region})`);
    return this.db
      .select()
      .from(hub)
      .where(and(...where))
      .orderBy(asc(hub.position), asc(hub.name))
      .limit(input.limit);
  }

  async pickupHub(id: string): Promise<PickupHub | null> {
    const rows = await this.db.select().from(hub).where(eq(hub.id, id)).limit(1);
    return rows[0] ?? null;
  }

  /**
   * An order's customer-facing history.
   *
   * Deliberately reads `order_events` rather than `audit_events`: the audit log
   * carries actor ids and internal notes that a shopper has no business seeing,
   * and mixing the two would make every future audit field a privacy review.
   */
  async tracking(orderId: string, customerId: string): Promise<OrderTracking | null> {
    const rows = await this.db
      .select()
      .from(ord)
      .where(and(eq(ord.id, orderId), eq(ord.customer_id, customerId)))
      .limit(1);
    const order = rows[0];
    if (!order) return null;

    const [events, shipments, pickup] = await Promise.all([
      this.db
        .select()
        .from(oe)
        .where(eq(oe.order_id, orderId))
        .orderBy(asc(oe.occurred_at), asc(oe.created_at)),
      this.db.select().from(ship).where(eq(ship.order_id, orderId)).limit(1),
      order.pickup_hub_id ? this.pickupHub(order.pickup_hub_id) : Promise.resolve(null),
    ]);

    return {
      order_id: order.id,
      order_number: order.order_number,
      status: order.status,
      fulfilment_method: order.fulfilment_method as 'courier' | 'pickup',
      pickup_hub: pickup,
      shipment: shipments[0] ?? null,
      delivered_at: order.delivered_at,
      return_window_ends_at: order.return_window_ends_at,
      events: events.map((e) => ({
        event_type: e.event_type,
        status: e.status,
        label: e.label,
        detail: e.detail,
        occurred_at: e.occurred_at,
      })),
    };
  }

  /**
   * The most recent event on each of several orders, for the orders list.
   *
   * "Most recent" is by `occurred_at` alone, and events written in one
   * transaction share it to the microsecond — so for an order whose last two
   * events landed together (shipping writes `order.fulfilling` and
   * `order.shipped` at once) which of the two comes back is not defined.
   * Fine for a "where has it got to" hint, not a basis for any decision.
   */
  async latestEvents(orderIds: string[]): Promise<Map<string, OrderEvent>> {
    if (orderIds.length === 0) return new Map();
    const rows = await this.db
      .select()
      .from(oe)
      // `inArray`, not `= ANY(...)`: Drizzle binds a JS array as one parameter,
      // node-postgres sends it untyped, and Postgres reads it as text — so the
      // statement dies with 22P02 comparing `uuid = ANY(text)`. The same shape
      // took every instalment quote down before it was found.
      .where(inArray(oe.order_id, orderIds))
      .orderBy(desc(oe.occurred_at));
    const latest = new Map<string, OrderEvent>();
    for (const row of rows) if (!latest.has(row.order_id)) latest.set(row.order_id, row);
    return latest;
  }

  // ------------------------------------------------------------------ writes

  /**
   * Moves a paid or financed order into fulfilment.
   *
   * Called implicitly by {@link markShipped} so a merchant does not have to
   * click twice; exposed on its own for a seller who wants to say "we are
   * packing it" before it leaves.
   */
  async startFulfilment(
    orderId: string,
    actor: PlanActor,
    opts: { merchantId?: string } = {},
    now: Date = new Date(),
  ): Promise<Order> {
    return this.transition(orderId, 'fulfilling', actor, opts, now, {
      eventType: 'order.fulfilling',
      label: 'Being prepared',
      detail: 'The seller is packing your order.',
    });
  }

  /**
   * Records that the order has left the seller.
   *
   * Creates the shipment row if there is not one yet — the courier details only
   * exist at this moment, so there is nothing to create earlier. Idempotent on
   * the status guard: shipping an already-shipped order updates the courier
   * details and leaves the status and the event alone.
   */
  async markShipped(
    orderId: string,
    rawInput: unknown,
    actor: PlanActor,
    opts: { merchantId?: string } = {},
    now: Date = new Date(),
  ): Promise<Order> {
    const input: MarkShippedInput = markShippedSchema.parse(rawInput);

    return runInTransaction(this.db, async (tx) => {
      const order = await this.lockOrder(tx, orderId, opts.merchantId);

      await this.upsertShipment(tx, orderId, {
        courier_name: input.courier_name ?? null,
        courier_phone: input.courier_phone ?? null,
        rider_name: input.rider_name ?? null,
        tracking_code: input.tracking_code ?? null,
        eta_at: input.eta_at ?? null,
        status: 'dispatched',
        shipped_at: now.toISOString(),
      });

      if (order.status === 'shipped') return order;

      // A seller who never marked "packing" still gets a coherent timeline: the
      // machine forbids paid -> shipped directly, so pass through fulfilling.
      if (order.status === 'paid' || order.status === 'financing_active') {
        await this.applyTransition(tx, order, 'fulfilling', actor, now, {
          eventType: 'order.fulfilling',
          label: 'Being prepared',
          detail: 'The seller is packing your order.',
        });
        order.status = 'fulfilling';
      }

      return this.applyTransition(tx, order, 'shipped', actor, now, {
        eventType: 'order.shipped',
        label: 'Shipped',
        detail: input.courier_name
          ? `On its way with ${input.courier_name}.`
          : (input.note ?? null),
      });
    });
  }

  /**
   * The last hop. Updates the shipment only — the order stays `shipped`,
   * because "out for delivery" is a courier state, not an order state, and
   * inventing an order status for it would put a value in the column that no
   * other consumer of the order lifecycle understands.
   */
  async markOutForDelivery(
    orderId: string,
    rawInput: unknown,
    actor: PlanActor,
    opts: { merchantId?: string } = {},
    now: Date = new Date(),
  ): Promise<Order> {
    const input: MarkOutForDeliveryInput = markOutForDeliverySchema.parse(rawInput);

    return runInTransaction(this.db, async (tx) => {
      const order = await this.lockOrder(tx, orderId, opts.merchantId);
      if (order.status !== 'shipped') {
        throw new OrderNotFulfillableError(orderId, order.status, 'out for delivery');
      }

      await this.upsertShipment(tx, orderId, {
        status: 'out_for_delivery',
        ...(input.rider_name ? { rider_name: input.rider_name } : {}),
        ...(input.courier_phone ? { courier_phone: input.courier_phone } : {}),
        ...(input.eta_at ? { eta_at: input.eta_at } : {}),
      });

      await this.recordEvent(tx, orderId, {
        eventType: 'order.out_for_delivery',
        status: order.status,
        label: 'Out for delivery',
        detail: input.rider_name ? `${input.rider_name} is on the way.` : (input.note ?? null),
        occurredAt: now,
      });

      return order;
    });
  }

  /**
   * Delivery — the event the rest of the system has been waiting for.
   *
   * This is what starts the return window, makes the line reviewable, and (for
   * a financed order) releases the layaway reserve against a real signal rather
   * than a staff member's guess.
   *
   * The engine hand-off runs AFTER the order transaction commits, because
   * `CustomerPlansService.markDelivered` opens its own. A failure there leaves a
   * delivered order whose reserve clock has not started — recoverable through
   * the existing `POST /admin/plans/:id/delivery`, which is idempotent, and far
   * better than rolling back a delivery that physically happened.
   */
  async markDelivered(
    orderId: string,
    rawInput: unknown,
    actor: PlanActor,
    opts: { merchantId?: string } = {},
    now: Date = new Date(),
  ): Promise<Order> {
    const input: MarkDeliveredInput = markDeliveredSchema.parse(rawInput);
    const deliveredAt = input.delivered_at ? new Date(input.delivered_at) : now;

    const order = await runInTransaction(this.db, async (tx) => {
      const locked = await this.lockOrder(tx, orderId, opts.merchantId);
      if (locked.status === 'delivered' || locked.status === 'completed') return locked;

      await this.upsertShipment(tx, orderId, {
        status: 'delivered',
        delivered_at: deliveredAt.toISOString(),
      });

      // The return window is the customer's promise and the merchant's payout
      // clock, so it is stamped once, here, from the order's own term.
      const windowEnds = new Date(
        deliveredAt.getTime() + locked.return_window_days * MS_PER_DAY,
      ).toISOString();

      return this.applyTransition(tx, locked, 'delivered', actor, deliveredAt, {
        eventType: 'order.delivered',
        label: locked.fulfilment_method === 'pickup' ? 'Collected' : 'Delivered',
        detail: input.received_by ? `Received by ${input.received_by}.` : (input.note ?? null),
        set: { delivered_at: deliveredAt.toISOString(), return_window_ends_at: windowEnds },
      });
    });

    if (order.customer_plan_id && this.plans) {
      await this.plans.markDelivered(
        order.customer_plan_id,
        { deliveredAt, reason: 'order delivered' },
        actor,
        now,
      );
    }

    return order;
  }

  /**
   * Closes orders whose return window has run out.
   *
   * `completed` is the state that says nobody is coming back — the merchant's
   * reserve can be released and the order is history. Driven by a sweep rather
   * than a timer per order, and safe to run repeatedly: the status guard means
   * an already-completed order is skipped rather than re-closed.
   */
  async completeElapsedReturnWindows(
    actor: PlanActor,
    now: Date = new Date(),
    limit = 500,
  ): Promise<string[]> {
    const due = await this.db
      .select({ id: ord.id })
      .from(ord)
      .where(and(eq(ord.status, 'delivered'), lte(ord.return_window_ends_at, now.toISOString())))
      .limit(limit);

    const closed: string[] = [];
    for (const row of due) {
      try {
        await this.transition(row.id, 'completed', actor, {}, now, {
          eventType: 'order.completed',
          label: 'Return window closed',
          detail: 'This order is complete and the seller has been settled.',
        });
        closed.push(row.id);
      } catch {
        // One order that moved underneath us must not stop the sweep.
      }
    }
    return closed;
  }

  // ---------------------------------------------------------------- internal

  private async transition(
    orderId: string,
    to: OrderStatus,
    actor: PlanActor,
    opts: { merchantId?: string },
    now: Date,
    event: { eventType: string; label: string; detail?: string | null },
  ): Promise<Order> {
    return runInTransaction(this.db, async (tx) => {
      const order = await this.lockOrder(tx, orderId, opts.merchantId);
      if (order.status === to) return order;
      return this.applyTransition(tx, order, to, actor, now, event);
    });
  }

  private async applyTransition(
    tx: TransactionalTx,
    order: Order,
    to: OrderStatus,
    actor: PlanActor,
    now: Date,
    event: {
      eventType: string;
      label: string;
      detail?: string | null;
      set?: Partial<typeof schema.orders.$inferInsert>;
    },
  ): Promise<Order> {
    const from = order.status as OrderStatus;
    assertOrderTransition(from, to);

    const rows = await tx
      .update(ord)
      .set({ status: to, ...(event.set ?? {}) })
      .where(and(eq(ord.id, order.id), eq(ord.status, from)))
      .returning();
    const updated = rows[0];
    // Lost a race with another writer; the guard is what makes every one of
    // these operations safe to retry.
    if (!updated) throw new OrderNotFulfillableError(order.id, order.status, to);

    await this.audit?.append(tx, {
      entityType: 'order',
      entityId: order.id,
      eventType: event.eventType,
      fromState: from,
      toState: to,
      actorId: actor.actorId,
      actorType: actor.actorType,
    });

    await this.recordEvent(tx, order.id, {
      eventType: event.eventType,
      status: to,
      label: event.label,
      detail: event.detail ?? null,
      occurredAt: now,
    });

    return updated;
  }

  private async lockOrder(
    tx: TransactionalTx,
    orderId: string,
    merchantId?: string,
  ): Promise<Order> {
    const where = merchantId
      ? and(eq(ord.id, orderId), eq(ord.merchant_id, merchantId))
      : eq(ord.id, orderId);
    const rows = await tx.select().from(ord).where(where).for('update').limit(1);
    const order = rows[0];
    // A merchant asking about someone else's order gets the same answer as one
    // asking about an order that does not exist.
    if (!order) throw new OrderNotFoundError(orderId);
    return order;
  }

  private async upsertShipment(
    tx: TransactionalTx,
    orderId: string,
    values: Partial<typeof schema.shipments.$inferInsert>,
  ): Promise<void> {
    // Nulls in `values` are "not supplied", not "clear it" — a courier update
    // that omits the tracking code must not wipe the one already recorded.
    const defined = Object.fromEntries(
      Object.entries(values).filter(([, v]) => v !== null && v !== undefined),
    );
    await tx
      .insert(ship)
      .values({ order_id: orderId, ...values, ...defined })
      .onConflictDoUpdate({ target: ship.order_id, set: defined });
  }

  private async recordEvent(
    tx: TransactionalTx,
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
}

function eqi(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function isoDate(from: Date, addDays: number): string {
  return new Date(from.getTime() + addDays * MS_PER_DAY).toISOString().slice(0, 10);
}
