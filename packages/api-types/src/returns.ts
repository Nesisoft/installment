import { z } from 'zod';

// Mirrors packages/commerce/src/modules/returns/dto.ts and
// merchant-returns.service.ts. Browser-safe copy: this package never imports
// the backend packages.

export const RETURN_STATUSES = ['requested', 'approved', 'rejected', 'cancelled'] as const;
export type ReturnStatus = (typeof RETURN_STATUSES)[number];

/** The seller's queue filters: every status, plus everything. */
export const MERCHANT_RETURN_BUCKETS = [...RETURN_STATUSES, 'all'] as const;
export type MerchantReturnBucket = (typeof MERCHANT_RETURN_BUCKETS)[number];

/**
 * Why the buyer wants to send it back. Required, and deliberately not from a
 * fixed list: "wrong size" and "arrived with the screen cracked" are different
 * decisions, and a dropdown would flatten the information the decision turns on.
 */
export const requestReturnSchema = z.object({
  reason: z.string().trim().min(1).max(1_000),
});
export type RequestReturnInput = z.infer<typeof requestReturnSchema>;

/** A refusal has to say why — `order_returns_rejection_needs_note` is a CHECK. */
export const rejectReturnSchema = z.object({
  decision_note: z.string().trim().min(1).max(1_000),
});
export type RejectReturnInput = z.infer<typeof rejectReturnSchema>;

/** The raw row, as the customer surface returns it. */
export interface OrderReturn {
  id: string;
  order_id: string;
  customer_id: string;
  status: ReturnStatus;
  reason: string;
  refund_amount_pesewas: number;
  requested_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * One return as the seller's queue draws it.
 *
 * The bare row carries an order id, a customer id and two amounts — nothing a
 * card can be built from — so the merchant surface projects the sale, the buyer
 * and what the decision costs.
 */
export interface MerchantReturnRow {
  id: string;
  orderId: string;
  orderNumber: string;
  status: ReturnStatus;
  reason: string;
  /** Fixed at request time from the order total, so a decision is about a known amount. */
  refundPesewas: number;
  requestedAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
  buyerName: string | null;
  buyerPhone: string | null;
  itemSummary: string | null;
  /**
   * What approving costs the seller: `total − commission` at the order's own
   * `commission_bps`, which is what the ledger reverses. Not recomputable from
   * the merchant's current default rate — that would be wrong for every order
   * placed before the last rate change.
   */
  merchantLosesPesewas: number;
  commissionReversedPesewas: number;
}

export interface MerchantReturnDetail extends MerchantReturnRow {
  items: { title: string; quantity: number; unitPricePesewas: number }[];
  orderTotalPesewas: number;
  orderStatus: string;
  orderPlacedAt: string | null;
}

export interface MerchantReturnCounts {
  requested: number;
  approved: number;
  rejected: number;
  cancelled: number;
  all: number;
}

export interface MerchantReturnPage {
  rows: MerchantReturnRow[];
  total: number;
}
