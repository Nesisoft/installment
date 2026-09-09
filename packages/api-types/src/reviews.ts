import { z } from 'zod';

// Mirrors packages/commerce/src/modules/catalog/storefront.dto.ts (the write
// schema) and packages/commerce/src/modules/shopper/reviews.service.ts (the
// row and the pending projection). Browser-safe copy: this package never
// imports the backend packages.
//
// Until this file the package carried exactly one review-shaped type —
// `StorefrontReview`, the public read model in storefront.ts — while
// `POST /me/reviews` and `GET /me/reviews/pending` had no mirror and no
// caller anywhere in the monorepo.

/**
 * A review is live or it is not.
 *
 * Introduced here AND backend-side in the same slice: the CHECK on
 * `product_reviews.status` has always been these two values and no code had
 * ever named them, so there was nothing for a mirror to be checked against.
 * Nothing writes `'hidden'` yet — there is no moderation path — which is worth
 * knowing before building a screen that assumes one.
 */
export const REVIEW_STATUSES = ['published', 'hidden'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const REVIEW_RATING_MIN = 1;
export const REVIEW_RATING_MAX = 5;
export const REVIEW_TITLE_MAX = 160;
export const REVIEW_BODY_MAX = 4_000;

/**
 * Writing a review.
 *
 * `rating` is a strict `z.number()` with no coercion — unlike the limit/offset
 * fields elsewhere in this package, which all use `z.coerce`. A form that hands
 * over the string `"5"` gets a validation failure rather than a review, so a
 * client must send a number.
 *
 * `title` and `body` are both optional with no minimum, so a rating on its own
 * is a complete review. That is deliberate: a star from someone who received
 * the thing is worth more than a blank text box is worth insisting on.
 */
export const createReviewSchema = z.object({
  order_item_id: z.string().uuid(),
  rating: z.number().int().min(REVIEW_RATING_MIN).max(REVIEW_RATING_MAX),
  title: z.string().trim().max(REVIEW_TITLE_MAX).optional(),
  body: z.string().trim().max(REVIEW_BODY_MAX).optional(),
});
export type CreateReviewInput = z.infer<typeof createReviewSchema>;

/** The row `POST /me/reviews` returns, straight out of `product_reviews`. */
export interface ProductReviewView {
  id: string;
  product_id: string;
  store_id: string;
  customer_id: string;
  /** One review per order line — `UNIQUE (order_item_id)` — so this is the identity. */
  order_item_id: string;
  rating: number;
  title: string | null;
  body: string | null;
  status: ReviewStatus;
  created_at: string;
  updated_at: string;
}

/**
 * One thing the buyer received and has not rated, from `GET /me/reviews/pending`.
 *
 * `product_id` is non-null here even though `order_items.product_id` is
 * nullable: the query filters the nulls out because `create` refuses them, so
 * every row in this list is one the buyer can actually submit.
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
