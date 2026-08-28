import { and, eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import { isUniqueViolation } from '@installment/core';
import { createReviewSchema, type CreateReviewInput } from '../catalog/storefront.dto';
import { ReviewConflictError, ReviewNotAllowedError } from './errors';

const rev = schema.product_reviews;
const oi = schema.order_items;
const ord = schema.orders;

export type ProductReview = typeof schema.product_reviews.$inferSelect;

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

  /** The order lines this customer could still review. */
  async reviewable(
    customerId: string,
  ): Promise<
    { order_item_id: string; order_id: string; product_id: string | null; title: string }[]
  > {
    return this.db
      .select({
        order_item_id: oi.id,
        order_id: oi.order_id,
        product_id: oi.product_id,
        title: oi.title,
      })
      .from(oi)
      .innerJoin(ord, eq(ord.id, oi.order_id))
      .where(
        and(
          eq(ord.customer_id, customerId),
          sql`${ord.status} IN ('delivered', 'completed')`,
          sql`NOT EXISTS (SELECT 1 FROM ${rev} WHERE ${rev.order_item_id} = ${oi.id})`,
        ),
      );
  }

  async mine(customerId: string): Promise<ProductReview[]> {
    return this.db.select().from(rev).where(eq(rev.customer_id, customerId));
  }
}
