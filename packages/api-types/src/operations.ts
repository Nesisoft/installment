import type { OrderStatus, RefundMethod, RefundStatus } from './enums';
import type { MerchantOrderDetail, Order } from './domain';
import type { OrderReturn } from './returns';

// The admin console's operations pages: refunds, orders, and the ledger check.

/**
 * Where a refund stands, for whoever has to make sure the customer is paid.
 * Mirrors `REFUND_QUEUES` in `packages/core/src/modules/refunds/refund.service.ts`
 * (checked by `apps/api/src/common/api-types-mirror.spec.ts`).
 */
export const REFUND_QUEUES = [
  'to_send',
  'in_flight',
  'unresolved',
  'failed',
  'to_pay_by_hand',
  'paid',
] as const;
export type RefundQueue = (typeof REFUND_QUEUES)[number];

/** One `refunds` row, as GET /admin/refunds/plan/:planId returns it. */
export interface Refund {
  id: string;
  customer_plan_id: string | null;
  schedule_id: string | null;
  order_return_id: string | null;
  amount_pesewas: number;
  reference: string;
  method: RefundMethod;
  provider_transaction_reference: string | null;
  paystack_refund_id: string | null;
  status: RefundStatus;
  last_error: string | null;
  requested_at: string;
  submitted_at: string | null;
  succeeded_at: string | null;
  failed_at: string | null;
}

/** One row of GET /admin/refunds: the refund, its queue, and who it is owed to. */
export interface RefundListRow {
  id: string;
  reference: string;
  amount_pesewas: number;
  method: RefundMethod;
  status: RefundStatus;
  queue: RefundQueue;
  last_error: string | null;
  /** The charge being refunded, as Paystack knows it — what to look up there. */
  provider_transaction_reference: string | null;
  paystack_refund_id: string | null;
  requested_at: string;
  submitted_at: string | null;
  succeeded_at: string | null;
  failed_at: string | null;
  customer_plan_id: string | null;
  schedule_id: string | null;
  order_return_id: string | null;
  order_id: string | null;
  order_number: string | null;
  customer_id: string | null;
  customer_name: string | null;
}

/** One entry of GET /admin/refunds/summary. */
export interface RefundQueueTotal {
  queue: RefundQueue;
  count: number;
  amount_pesewas: number;
  oldest_requested_at: string | null;
}

export interface ListRefundsParams {
  queue?: RefundQueue;
  limit?: number;
  offset?: number;
}

/** Body of POST /admin/refunds/:reference/settle-manual. */
export interface SettleRefundManuallyInput {
  /** How it was paid: a transfer reference, a receipt number, who handed it over. */
  note?: string;
  /**
   * Required (with `note`) for an `unresolved` refund: the caller looked the
   * charge up in the Paystack dashboard and it carries no refund.
   */
  checked_paystack?: boolean;
}

/** What POST /admin/refunds/:reference/send answers. */
export interface DisburseResult {
  refundId: string;
  reference: string;
  outcome: 'succeeded' | 'pending_confirmation' | 'failed' | 'unknown' | 'skipped';
  reason?: string;
}

// --- Ledger integrity ---------------------------------------------------------

/** GET /admin/ledger/integrity. Mirrors `IntegrityReport` in core. */
export interface LedgerIntegrityReport {
  checkedAt: string;
  trialBalance: {
    rows: Array<{
      accountType: string;
      debitsPesewas: number;
      creditsPesewas: number;
      balancePesewas: number;
    }>;
    totalPesewas: number;
    balanced: boolean;
  };
  unbalancedTransactions: Array<{
    transactionId: string;
    debitsPesewas: number;
    creditsPesewas: number;
    driftPesewas: number;
  }>;
  healthy: boolean;
}

// --- Admin orders -------------------------------------------------------------

/** One row of GET /admin/orders: the order, and who it is between. */
export interface AdminOrderRow extends Order {
  item_count: number;
  customer_name: string | null;
  merchant_name: string | null;
  store_name: string | null;
}

/** A return on the order, with the refund it raised, if any. */
export interface AdminOrderReturn extends OrderReturn {
  refund: {
    reference: string;
    status: RefundStatus;
    method: RefundMethod;
    amount_pesewas: number;
  } | null;
}

/** GET /admin/orders/:id: the seller's order sheet, plus who and the returns. */
export interface AdminOrderDetail extends MerchantOrderDetail {
  customer: { id: string; name: string | null; phone: string; email: string } | null;
  merchant: { id: string; business_name: string } | null;
  store: { id: string; display_name: string; slug: string } | null;
  returns: AdminOrderReturn[];
}

export type AdminOrderCounts = Record<OrderStatus | 'all', number>;

export interface ListAdminOrdersParams {
  status?: OrderStatus;
  payment_type?: 'full' | 'installment';
  q?: string;
  limit?: number;
  offset?: number;
}
