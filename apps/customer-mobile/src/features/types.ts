/**
 * Wire shapes the app reads.
 *
 * The storefront read models are re-exported from `@installment/api-types` so
 * there is ONE definition of them shared with the web apps — they were briefly
 * duplicated here, and a duplicated wire type is a wire type that drifts.
 * Everything below the re-export is app-facing shape that the shared package
 * does not carry yet.
 *
 * Field names are snake_case throughout: that is what the API sends, and
 * renaming at the boundary would only add a layer to get wrong. Every amount is
 * integer pesewas; every timestamp is ISO-8601 (see `lib/dates` for the parsing
 * trap).
 */

// `export type { … }` re-exports without binding locally, and shapes below
// reference PickupHub, so it is imported as well as re-exported.
import type { PickupHub } from '@installment/api-types';

export type {
  CustomerReturnBucket,
  CustomerReturnCounts,
  CustomerReturnRow,
  CustomerReturnsPage,
  DeliveryQuote,
  HomeFeed,
  PickupHub,
  PlanQuote,
  QuotedInstallment,
  StorefrontCategory,
  StorefrontImage as ProductImage,
  StorefrontProduct,
  StorefrontProductDetails,
  StorefrontReview,
  StorefrontStore,
  StorefrontVariant as ProductVariant,
  TrendingTerm,
  ProductReviewView,
  ReviewablePurchase,
  ReturnStatus,
} from '@installment/api-types';

// Re-exported as VALUES, not types: the returns list renders a chip per bucket
// and the request form caps its own text field, and a second copy of either
// here is the drift `api-types-mirror.spec.ts` exists to stop.
export {
  CUSTOMER_RETURN_BUCKETS,
  REQUEST_RETURN_REASON_MAX,
  REVIEW_RATING_MAX,
  REVIEW_TITLE_MAX,
  REVIEW_BODY_MAX,
} from '@installment/api-types';

export interface Paginated<T> {
  rows: T[];
  total: number;
}

// --- Instalment plans --------------------------------------------------------

export interface CustomerPlan {
  id: string;
  status: string;
  number_of_installments: number;
  installment_frequency_days: number;
  grace_period_days: number;
  order_amount_pesewas: number;
  down_payment_pesewas: number;
  financed_amount_pesewas: number;
  total_payable_pesewas: number;
  outstanding_pesewas: number;
  autopay_enabled: boolean;
  late_fee_bps_per_week: number;
  late_fee_cap_bps: number;
  activated_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface InstallmentRow {
  id: string;
  customer_plan_id: string;
  sequence_number: number;
  amount_due_pesewas: number;
  amount_paid_pesewas: number;
  late_fee_pesewas: number;
  due_date: string;
  grace_until_date: string;
  status: string;
  paid_at: string | null;
  attempt_count: number;
  next_retry_at: string | null;
}

export interface FeedInstallment extends InstallmentRow {
  /** Position among the plan's rows, deposit included — "instalment 2 of 4". */
  position: number;
  total_installments: number;
  payable_pesewas: number;
  is_down_payment: boolean;
  is_overdue: boolean;
  plan: {
    id: string;
    status: string;
    outstanding_pesewas: number;
    total_payable_pesewas: number;
    autopay_enabled: boolean;
    installment_frequency_days: number;
    grace_period_days: number;
    late_fee_bps_per_week: number;
    late_fee_cap_bps: number;
  };
  merchant_name: string | null;
  order_id: string | null;
  order_number: string | null;
  item_title: string | null;
}

// --- Cart, checkout, orders --------------------------------------------------

export interface CartLine {
  id: string;
  variant_id: string;
  merchant_id: string;
  quantity: number;
  unit_price_pesewas: number;
  line_total_pesewas: number;
  title: string;
  sku: string;
  product_id: string | null;
  image_url: string | null;
  store_id: string | null;
  store_slug: string | null;
  store_display_name: string | null;
  option_values: Record<string, unknown>;
  quantity_available: number;
  purchasable: boolean;
  installment_eligible: boolean;
}

export interface Cart {
  id: string;
  status: string;
  items: CartLine[];
  subtotal_pesewas: number;
  store_count: number;
  item_count: number;
}

export interface Address {
  id: string;
  recipient: string;
  phone: string;
  region: string;
  city: string;
  area: string | null;
  landmark: string | null;
  ghanapost_gps: string | null;
  is_default: boolean;
}

export interface OrderItem {
  id: string;
  variant_id: string | null;
  product_id: string | null;
  title: string;
  sku: string;
  quantity: number;
  unit_price_pesewas: number;
  line_total_pesewas: number;
}

export interface Order {
  id: string;
  order_number: string;
  customer_id: string;
  merchant_id: string;
  store_id: string;
  payment_type: 'full' | 'installment';
  subtotal_pesewas: number;
  shipping_pesewas: number;
  discount_pesewas: number;
  total_pesewas: number;
  status: OrderStatus;
  fulfilment_method: 'courier' | 'pickup';
  pickup_hub_id: string | null;
  shipping_address_id: string | null;
  application_id: string | null;
  customer_plan_id: string | null;
  return_window_days: number;
  delivered_at: string | null;
  return_window_ends_at: string | null;
  placed_at: string | null;
  created_at: string;
  items: OrderItem[];
}

export type OrderStatus =
  | 'pending_payment'
  | 'pending_approval'
  | 'paid'
  | 'financing_active'
  | 'fulfilling'
  | 'shipped'
  | 'delivered'
  | 'completed'
  | 'cancelled'
  | 'payment_failed'
  | 'declined'
  | 'returned'
  | 'defaulted';

export interface OrderWithPlan extends Order {
  plan: CustomerPlan | null;
  schedule: InstallmentRow[];
  pickup_hub: PickupHub | null;
}

/** What `POST /me/checkout` returns: the order and the credit decision on it. */
export type CheckoutOutcome = 'paid_later' | 'approved' | 'declined' | 'in_review' | 'failed';

export interface DecidedOrder {
  order: Order;
  outcome: CheckoutOutcome;
  application_id: string | null;
  plan: CustomerPlan | null;
  schedule: InstallmentRow[];
  down_payment: InstallmentRow | null;
  approved_limit_pesewas: number | null;
  message: string | null;
}

export interface OrderEvent {
  event_type: string;
  status: string | null;
  label: string;
  detail: string | null;
  occurred_at: string;
}

export interface Shipment {
  id: string;
  courier_name: string | null;
  courier_phone: string | null;
  rider_name: string | null;
  tracking_code: string | null;
  status: string;
  eta_at: string | null;
  shipped_at: string | null;
  delivered_at: string | null;
}

export interface OrderTracking {
  order_id: string;
  order_number: string;
  status: OrderStatus;
  fulfilment_method: 'courier' | 'pickup';
  pickup_hub: PickupHub | null;
  shipment: Shipment | null;
  delivered_at: string | null;
  return_window_ends_at: string | null;
  events: OrderEvent[];
}

// --- Account -----------------------------------------------------------------

export interface CreditStanding {
  approved_limit_pesewas: number;
  in_use_pesewas: number;
  available_pesewas: number;
  on_time_payments: number;
  late_payments: number;
  total_payments: number;
  active_plans: number;
  has_limit: boolean;
  last_reviewed_at: string | null;
}

export type MomoProvider = 'mtn' | 'vod' | 'tgo';

/**
 * A hosted card checkout. The card never reaches us — the customer completes
 * the payment on the provider's page and the order settles by webhook, so the
 * app learns the outcome by polling the order, not from this response.
 */
export interface CardCheckoutSession {
  reference: string;
  authorization_url: string;
  access_code: string;
}

export interface CustomerProfile {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  momo_phone: string | null;
  momo_provider: MomoProvider | null;
  kyc_tier: number;
  ghana_card_verified: boolean;
  /** `YYYY-MM-DD`, or null for an account opened before signup asked. */
  date_of_birth: string | null;
  consents: {
    data_processing_at: string | null;
    credit_scoring_at: string | null;
    marketing_at: string | null;
  };
  credit: CreditStanding;
  counts: { active_plans: number; total_plans: number; saved_items: number };
  created_at: string;
}

/**
 * What a Mobile Money charge answers. An order's charge says `paid`; an
 * instalment's says `succeeded`, or `unknown` when Paystack's answer did not
 * settle it (the verify poll does). A decline is HTTP 200 with `failed`.
 */
export interface ChargeResult {
  status: 'paid' | 'succeeded' | 'pending' | 'unknown' | 'failed';
  reference?: string;
  message?: string;
  failureReason?: string;
}

// --- Ghana Card (KYC tier 1) --------------------------------------------------

export type GhanaCardStatus = 'submitted' | 'approved' | 'rejected';

export interface GhanaCardStatusView {
  /** `null` until a card has been sent at all. */
  status: GhanaCardStatus | null;
  card_number_masked: string | null;
  has_scan: boolean;
  verified: boolean;
  verified_at: string | null;
  reviewed_at: string | null;
  rejection_reason: string | null;
  kyc_tier: number;
}

/** What `POST /me/uploads` hands back for a direct-to-storage PUT. */
export interface PresignedUpload {
  key: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  expires_at: string;
}
