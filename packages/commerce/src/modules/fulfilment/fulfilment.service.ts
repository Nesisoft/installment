import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
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
  constructor(private readonly db: Database) {}

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

  /** The most recent event on each of several orders, for the orders list. */
  async latestEvents(orderIds: string[]): Promise<Map<string, OrderEvent>> {
    if (orderIds.length === 0) return new Map();
    const rows = await this.db
      .select()
      .from(oe)
      .where(sql`${oe.order_id} = ANY(${orderIds})`)
      .orderBy(desc(oe.occurred_at));
    const latest = new Map<string, OrderEvent>();
    for (const row of rows) if (!latest.has(row.order_id)) latest.set(row.order_id, row);
    return latest;
  }
}

function eqi(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function isoDate(from: Date, addDays: number): string {
  return new Date(from.getTime() + addDays * MS_PER_DAY).toISOString().slice(0, 10);
}
