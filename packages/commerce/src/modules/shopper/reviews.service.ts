import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import { isUniqueViolation } from '@installment/core';
import { createReviewSchema, type CreateReviewInput } from '../catalog/storefront.dto';
import { ReviewConflictError, ReviewNotAllowedError } from './errors';

const rev = schema.product_reviews;
const oi = schema.order_items;
const ord = schema.orders;
const st = schema.stores;

/**
 * How many unrated lines one response will carry.
 *
 * The query had no limit and no ordering at all, so a customer with a long
 * history got their entire unrated history in arbitrary order — and the screen
 * that renders it is a queue, not an archive. Newest first, because the thing
 * you just received is the thing you have an opinion about.
 */
const REVIEWABLE_LIMIT = 50;

export type ProductReview = typeof schema.product_reviews.$inferSelect;

/**
 * One thing the buyer received and has not rated.
 *
 * `product_id` is non-null by construction — the query filters the nulls out
 * precisely because `create` refuses them — so the client never has to hold a
 * card it cannot submit.
 */
export interface ReviewablePurchase {
  order_item_id: string;
  order_id: string;
  product_id: string;
  /** The line's snapshot of the product name AT PURCHASE, not the current one. */
  title: string;
  store_name: string | null;
  /** Null on an order that reached 'completed' without the column being stamped. */
  delivered_at: string | null;
  order_number: string;
}

/** Order statuses at which the goods are in the customer's hands. */
const DELIVERED_STATUSES = ['delivered', 'completed'] as const;

/**
 * Customer product reviews, gated on delivery.
 *
 * A rating is only worth showing if it came from someone who received the thing,
 * so a review is attached to an `order_items` row on a delivered order, one
 * review per line. That makes the gate a foreign key and a unique index rather
 * than a policy someone has to remember to enforce, and it means a customer who
 * bought the same product twice can review it twice — which is honest, because
 * they had two of them.
 */
export class ReviewsService {
  constructor(private readonly db: Database) {}

  async create(customerId: string, rawInput: unknown): Promise<ProductReview> {
    const input: CreateReviewInput = createReviewSchema.parse(rawInput);

    const rows = await this.db
      .select({
        order_item_id: oi.id,
        product_id: oi.product_id,
        store_id: ord.store_id,
        status: ord.status,
        customer_id: ord.customer_id,
      })
      .from(oi)
      .innerJoin(ord, eq(ord.id, oi.order_id))
      .where(eq(oi.id, input.order_item_id))
      .limit(1);

    const line = rows[0];
    // A line belonging to someone else is reported as "not yours to review"
    // rather than "no such line": the caller supplied the id, so its existence
    // is not a secret, but the order behind it is.
    if (!line || line.customer_id !== customerId) {
      throw new ReviewNotAllowedError('That order line is not yours to review');
    }
    if (!DELIVERED_STATUSES.includes(line.status as (typeof DELIVERED_STATUSES)[number])) {
      throw new ReviewNotAllowedError('You can review an item once it has been delivered');
    }
    if (!line.product_id) {
      throw new ReviewNotAllowedError('This product is no longer listed');
    }

    try {
      const inserted = await this.db
        .insert(rev)
        .values({
          product_id: line.product_id,
          store_id: line.store_id,
          customer_id: customerId,
          order_item_id: line.order_item_id,
          rating: input.rating,
          title: input.title ?? null,
          body: input.body ?? null,
        })
        .returning();
      return inserted[0]!;
    } catch (err) {
      if (isUniqueViolation(err, 'product_reviews_order_item_id_key')) {
        throw new ReviewConflictError('You have already reviewed this item');
      }
      throw err;
    }
  }

  /**
   * The order lines this customer could still review.
   *
   * Every condition here is one `create` also enforces, and that is the point:
   * this list shipped returning lines whose `product_id` was NULL —
   * `order_items.product_id` is `ON DELETE SET NULL`, so a delisted product
   * empties it — while `create` refuses exactly those with "This product is no
   * longer listed". The queue offered a card whose only outcome was a 422 the
   * buyer could do nothing about. A pending list that disagrees with the
   * endpoint it feeds is worse than no list.
   *
   * The shop name and the delivery date are joined in because the screen needs
   * to say which purchase a line was: "Shea Butter 500g" alone is not a
   * recognisable thing to have an opinion about six weeks later.
   */
  async reviewable(customerId: string): Promise<ReviewablePurchase[]> {
    const rows = await this.db
      .select({
        order_item_id: oi.id,
        order_id: oi.order_id,
        // Narrowed from `string | null` below: the WHERE guarantees it.
        product_id: oi.product_id,
        title: oi.title,
        store_name: st.display_name,
        delivered_at: ord.delivered_at,
        order_number: ord.order_number,
      })
      .from(oi)
      .innerJoin(ord, eq(ord.id, oi.order_id))
      .leftJoin(st, eq(st.id, ord.store_id))
      .where(
        and(
          eq(ord.customer_id, customerId),
          sql`${ord.status} IN ('delivered', 'completed')`,
          // The fix. `create` throws on a null product_id, so a row here with
          // one is a card that cannot be submitted.
          isNotNull(oi.product_id),
          // Matches ANY review row, hidden ones included — a line that has been
          // reviewed and then moderated away is not offered again, because the
          // unique index would refuse the second insert anyway.
          sql`NOT EXISTS (SELECT 1 FROM ${rev} WHERE ${rev.order_item_id} = ${oi.id})`,
        ),
      )
      // `delivered_at` is null on an order that reached 'completed' without the
      // column being stamped, so the id is the tiebreak rather than the sort.
      .orderBy(desc(ord.delivered_at), desc(oi.id))
      .limit(REVIEWABLE_LIMIT);

    return rows.map((row) => ({
      order_item_id: row.order_item_id,
      order_id: row.order_id,
      product_id: row.product_id!,
      title: row.title,
      store_name: row.store_name,
      delivered_at: row.delivered_at,
      order_number: row.order_number,
    }));
  }

  async mine(customerId: string): Promise<ProductReview[]> {
    return this.db.select().from(rev).where(eq(rev.customer_id, customerId));
  }
}
