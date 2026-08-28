/**
 * Wire shapes the app reads.
 *
 * These mirror the projections `@installment/commerce` and `@installment/core`
 * return. They are declared here rather than imported from `@installment/api-types`
 * because that package mirrors *request* schemas and table rows, while these are
 * assembled read models — and because the app must not pull a package that
 * imports Drizzle into a Metro bundle.
 *
 * Field names are snake_case throughout: that is what the API sends, and
 * renaming at the boundary would only add a layer to get wrong.
 */

export interface Paginated<T> {
  rows: T[];
  total: number;
}

export interface StorefrontProduct {
  id: string;
  store_id: string;
  merchant_id: string;
  category_id: string | null;
  title: string;
  base_price_pesewas: number;
  compare_at_price_pesewas: number | null;
  discount_percent: number | null;
  deal_ends_at: string | null;
  currency: string;
  primary_image_url: string | null;
  primary_image_alt: string | null;
  store_slug: string;
  store_display_name: string;
  store_logo_url: string | null;
  store_verified: boolean;
  rating_avg: number | null;
  rating_count: number;
  sold_count: number;
  installment_eligible: boolean;
  in_stock: boolean;
  created_at: string;
}

export interface StorefrontStore {
  id: string;
  slug: string;
  display_name: string;
  about: string | null;
  city: string | null;
  region: string | null;
  verified: boolean;
  logo_url: string | null;
  banner_url: string | null;
  support_phone: string | null;
  joined_at: string;
  product_count: number;
  rating_avg: number | null;
  rating_count: number;
  order_count: number;
  on_time_percent: number | null;
}

export interface StorefrontCategory {
  id: string;
  parent_id: string | null;
  name: string;
  slug: string;
  position: number;
  image_url: string | null;
  accent_hex: string | null;
  product_count: number;
}

export interface ProductVariant {
  id: string;
  sku: string;
  option_values: Record<string, unknown>;
  price_pesewas: number | null;
  effective_price_pesewas: number;
  is_active: boolean;
  quantity_available: number;
}

export interface ProductImage {
  id: string;
  url: string | null;
  alt_text: string | null;
  position: number;
}

export interface StorefrontProductDetails extends StorefrontProduct {
  description: string | null;
  attributes: Record<string, unknown>;
  images: ProductImage[];
  variants: ProductVariant[];
  variant_label: string | null;
  plan_template_ids: string[];
  store: StorefrontStore;
  category: { id: string; name: string; slug: string } | null;
}

export interface HomeFeed {
  categories: StorefrontCategory[];
  deals: StorefrontProduct[];
  deals_end_at: string | null;
  installment_picks: StorefrontProduct[];
  newest: StorefrontProduct[];
}

export interface StorefrontReview {
  id: string;
  rating: number;
  title: string | null;
  body: string | null;
  author: string;
  created_at: string;
}

// --- Instalment plans --------------------------------------------------------

export interface QuotedInstallment {
  sequence_number: number;
  kind: 'down_payment' | 'installment';
  amount_pesewas: number;
  due_date: string;
  grace_until_date: string;
}

export interface PlanQuote {
  plan_template_id: string;
  name: string;
  description: string | null;
  business_model: string;
  /** Excludes the deposit — the engine's own definition. Count `installments` for display. */
  number_of_installments: number;
  installment_frequency_days: number;
  grace_period_days: number;
  down_payment_bps: number;
  interest_rate_bps: number;
  service_fee_flat_pesewas: number;
  late_fee_bps_per_week: number;
  late_fee_cap_bps: number;
  min_amount_pesewas: number;
  max_amount_pesewas: number;
  down_payment_pesewas: number;
  financed_amount_pesewas: number;
  total_interest_pesewas: number;
  total_fees_pesewas: number;
  total_payable_pesewas: number;
  per_installment_pesewas: number;
  installments: QuotedInstallment[];
  eligible: boolean;
  ineligible_reason: string | null;
}

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

export interface PickupHub {
  id: string;
  name: string;
  region: string;
  city: string;
  area: string | null;
  detail: string | null;
  is_active: boolean;
  position: number;
}

export interface DeliveryQuote {
  fulfilment_method: 'courier';
  fee_pesewas: number;
  eta_min_days: number;
  eta_max_days: number;
  eta_earliest: string;
  eta_latest: string;
  matched: 'city' | 'region' | 'national';
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
  consents: {
    data_processing_at: string | null;
    credit_scoring_at: string | null;
    marketing_at: string | null;
  };
  credit: CreditStanding;
  counts: { active_plans: number; total_plans: number; saved_items: number };
  created_at: string;
}

export interface ChargeResult {
  status: 'paid' | 'pending' | 'failed';
  reference: string;
  message?: string;
}

export interface TrendingTerm {
  term: string;
  searches: number;
}
