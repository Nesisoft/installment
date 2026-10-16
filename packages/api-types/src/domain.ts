// Domain row + view-model types the React apps render. Field names match the
// backend $inferSelect shapes; money fields are integer pesewas, rates are bps,
// timestamps are ISO strings, *_date fields are date-only strings.

import type {
  ApplicationStatus,
  BusinessModel,
  CollectionsActionType,
  CollectionsResolution,
  CollectionsStage,
  CustomerPlanStatus,
  DecisionOutcome,
  EmployerSector,
  EmployerStatus,
  EmploymentStatus,
  InstallmentFrequencyDays,
  InstallmentStatus,
  LedgerDirection,
  MerchantStatsWindow,
  MerchantStatus,
  MomoProvider,
  NotificationChannel,
  NotificationStatus,
  PayoutStatus,
  PayrollCycle,
  PaymentAttemptStatus,
  PaymentChannel,
  PaymentMethod,
  PaymentProvider,
  RiskBand,
  CartStatus,
  FulfilmentMethod,
  OrderSource,
  OrderStatus,
  PaymentType,
  ProductStatus,
  RuleCategory,
  SalaryBand,
  StoreStatus,
  TelcoHealthStatus,
} from './enums';

export interface Merchant {
  id: string;
  business_name: string;
  legal_name: string;
  email: string;
  phone: string;
  tin: string | null;
  registration_number: string | null;
  default_business_model: BusinessModel;
  /** Display only since migration 0009 — charged by nothing. Read `fees` or the overrides. */
  default_mdr_bps: number;
  default_reserve_bps: number;
  /** A negotiated MDR, in bps. NULL: each plan charges its business model's own rate. */
  mdr_bps_override: number | null;
  /** A negotiated reserve, in bps. NULL: each plan holds its business model's own rate. */
  reserve_bps_override: number | null;
  /** A negotiated commission on paid-in-full orders, in bps. NULL: the platform default. */
  commission_bps_override: number | null;
  /**
   * The payout floor. A settlement run below this rolls into the next one
   * instead of paying out — no row is written and nothing is queued, so the
   * seller sees no payout at all that night. Served by `/merchant/me` since the
   * column existed; it was simply never declared here, so no client could read
   * the number it needed to explain a missing payout.
   */
  min_payout_pesewas: number;
  status: MerchantStatus;
  paystack_recipient_code: string | null;
  bank_account_number: string | null;
  bank_account_name: string | null;
  bank_code: string | null;
  onboarded_at: string | null;
  suspended_at: string | null;
  suspension_reason: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

/** One plan type's cost to the seller, in basis points of the sale. */
export interface PlanFees {
  mdr_bps: number;
  reserve_bps: number;
}

/**
 * What a sale costs this seller, computed server-side from the rules that
 * charge it. Paid in full: the marketplace commission, no reserve. On a plan:
 * the rates of the plan the BUYER picks — so every business model is listed,
 * and a negotiated rate shows as the same figure in each.
 */
export interface SellerFees {
  pay_now_commission_bps: number;
  plans: Record<BusinessModel, PlanFees>;
  mdr_negotiated: boolean;
  reserve_negotiated: boolean;
  commission_negotiated: boolean;
}

/**
 * `GET /merchant/me` and `GET /admin/merchants/:id`: the merchant, plus `fees`.
 * Optional on purpose: a mobile build can be talking to an API deployed before
 * `fees` existed, and the type should make every reader say what it shows then.
 */
export interface MerchantProfile extends Merchant {
  fees?: SellerFees;
}

export interface Customer {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  date_of_birth: string | null;
  ghana_card_number: string | null;
  /** Object-storage key of the scan; the console reads it behind a signed URL. */
  ghana_card_image_key: string | null;
  ghana_card_verified: boolean;
  ghana_card_verified_at: string | null;
  momo_phone: string | null;
  momo_provider: MomoProvider | null;
  kyc_tier: number;
  is_on_blocklist: boolean;
  blocklist_reason: string | null;
  data_processing_consent_at: string | null;
  credit_scoring_consent_at: string | null;
  marketing_consent_at: string | null;
  last_login_at: string | null;
  user_id: string | null;
  created_at: string;
}

export interface PlanTemplate {
  id: string;
  name: string;
  description: string | null;
  business_model: BusinessModel;
  number_of_installments: number;
  installment_frequency_days: InstallmentFrequencyDays;
  down_payment_bps: number;
  interest_rate_bps: number;
  service_fee_flat_pesewas: number;
  late_fee_pesewas: number;
  grace_period_days: number;
  min_amount_pesewas: number;
  max_amount_pesewas: number;
  eligible_categories: string[];
  excluded_categories: string[];
  is_active: boolean;
  effective_from: string | null;
  effective_to: string | null;
  created_at: string;
}

/** The plan terms an application locked at submit; activation prices the plan from these. */
export interface PlanTerms {
  business_model: BusinessModel;
  number_of_installments: number;
  installment_frequency_days: number;
  down_payment_bps: number;
  interest_rate_bps: number;
  service_fee_flat_pesewas: number;
  grace_period_days: number;
  late_fee_bps_per_week: number;
  late_fee_cap_bps: number;
}

export interface Application {
  id: string;
  customer_id: string;
  merchant_id: string;
  plan_template_id: string;
  /** The terms the customer applied under — not the template's current ones. */
  plan_terms: PlanTerms;
  order_reference: string;
  order_amount_pesewas: number;
  merchant_category: string;
  status: ApplicationStatus;
  decision_at: string | null;
  declined_reason: string | null;
  counter_down_payment_pesewas: number | null;
  counter_financed_pesewas: number | null;
  expires_at: string;
  created_at: string;
}

export interface RuleResult {
  ruleId: string;
  category: RuleCategory;
  passed: boolean;
  points: number;
  reason?: string;
}

export interface CreditProfile {
  id: string;
  customer_id: string;
  application_id: string;
  score: number;
  risk_band: RiskBand;
  outcome: DecisionOutcome;
  approved_limit_pesewas: number | null;
  ruleset_version: string;
  rules_fired: RuleResult[];
  features_snapshot: Record<string, unknown>;
  decided_at: string;
}

// --- Scoring engine output (camelCase, amounts in GHS — note: NOT pesewas) ---

export interface FeatureVector {
  identity: {
    ghanaCardVerified: boolean;
    phoneVerified: boolean;
    phoneAgeDays: number;
    addressProofUploaded: boolean;
    kycTier: 0 | 1 | 2;
    ageYears: number | null;
  };
  repayment: {
    completedPlansCount: number;
    onTimePaymentRate: number;
    averageDaysPastDue: number;
    priorDefaults12mo: number;
    priorDefaultsAllTime: number;
    consecutiveOnTime: number;
  };
  behavior: {
    /** Instalment charges we collected successfully — not the customer's wider payment life. */
    successfulChargeCount: number;
    momoTransactionShare: number;
    averageTransactionGhs: number;
    failedChargeRate90d: number;
  };
  tenure: {
    accountAgeDays: number;
    loginsLast30Days: number;
    deviceFingerprintKnown: boolean;
    distinctDevicesLast90Days: number;
  };
  employment: {
    employerLinked: boolean;
    salaryBand: SalaryBand;
    employmentMonths: number | null;
    payrollDeductionConsent: boolean;
  };
  exposure: {
    activePlansCount: number;
    outstandingBalanceGhs: number;
    currentLimitGhs: number;
    applicationsLast24h: number;
    isOnBlocklist: boolean;
  };
  request: {
    orderAmountGhs: number;
    merchantCategory: string;
    planTemplateId: string;
    planMinGhs: number;
    planMaxGhs: number;
    /**
     * The chosen plan's deposit, in basis points. Carried because the money at
     * risk is what the plan *finances*, not what the order costs: at 4000 bps a
     * GHS 400 order lends GHS 240, and at 0 bps the same order lends the whole
     * GHS 400. A policy capped on the order amount would quietly take two-thirds
     * more exposure on the zero-deposit template.
     */
    downPaymentBps: number;
  };
}

export interface CounterOffer {
  downPaymentGhs: number;
  revisedAmountGhs: number;
  revisedTermMonths: number;
}

/** Returned by POST /admin/applications/:id/score/dry-run. */
export interface ScoringDecision {
  outcome: DecisionOutcome;
  score: number;
  riskBand: RiskBand;
  approvedLimitGhs: number;
  counterOffer?: CounterOffer;
  rulesetVersion: string;
  rulesFired: RuleResult[];
  featuresSnapshot: FeatureVector;
  decidedAt: string;
}

/** Returned by POST /admin/applications/:id/score. */
export interface ScoreResult {
  decision: ScoringDecision;
  application: Application;
  creditProfile: CreditProfile;
}

export interface CustomerPlan {
  id: string;
  customer_id: string;
  merchant_id: string;
  plan_template_id: string;
  application_id: string;
  business_model: BusinessModel;
  number_of_installments: number;
  installment_frequency_days: number;
  grace_period_days: number;
  mdr_bps: number;
  reserve_bps: number;
  order_amount_pesewas: number;
  down_payment_pesewas: number;
  financed_amount_pesewas: number;
  total_interest_pesewas: number;
  total_fees_pesewas: number;
  total_payable_pesewas: number;
  outstanding_pesewas: number;
  status: CustomerPlanStatus;
  approved_at: string | null;
  activated_at: string | null;
  completed_at: string | null;
  defaulted_at: string | null;
  product_delivered_at: string | null;
  restructured_from_plan_id: string | null;
  created_at: string;
}

export interface InstallmentScheduleRow {
  id: string;
  customer_plan_id: string;
  sequence_number: number;
  amount_due_pesewas: number;
  amount_paid_pesewas: number;
  late_fee_pesewas: number;
  due_date: string;
  grace_until_date: string | null;
  status: InstallmentStatus;
  status_changed_at: string | null;
  attempt_count: number;
  last_attempt_at: string | null;
  last_failure_reason: string | null;
  next_retry_at: string | null;
  paid_at: string | null;
  provider_reference: string | null;
}

export interface PaymentAttempt {
  id: string;
  schedule_id: string;
  customer_plan_id: string;
  provider: PaymentProvider;
  channel: PaymentChannel;
  payment_method: PaymentMethod | null;
  amount_pesewas: number;
  idempotency_key: string;
  provider_reference: string | null;
  payment_link_url: string | null;
  status: PaymentAttemptStatus;
  failure_reason: string | null;
  verify_poll_count: number;
  last_verified_at: string | null;
  initiated_at: string;
  settled_at: string | null;
  failed_at: string | null;
}

export interface Employer {
  id: string;
  name: string;
  sector: EmployerSector | null;
  status: EmployerStatus;
  payroll_cycle: PayrollCycle;
  partnership_start_date: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface CustomerEmployment {
  id: string;
  customer_id: string;
  employer_id: string;
  employee_number: string | null;
  salary_band: SalaryBand;
  employment_start_date: string | null;
  payroll_deduction_consent: boolean;
  consent_signed_at: string | null;
  status: EmploymentStatus;
  verified_at: string | null;
}

export interface CollectionsCase {
  id: string;
  customer_plan_id: string;
  schedule_id: string | null;
  current_stage: CollectionsStage;
  stage_entered_at: string;
  assigned_agent_id: string | null;
  opened_at: string;
  closed_at: string | null;
  resolution: CollectionsResolution | null;
  amount_recovered_pesewas: number;
  notes: string | null;
}

export interface CollectionsAction {
  id: string;
  case_id: string;
  action_type: CollectionsActionType;
  channel: string | null;
  outcome: string | null;
  notes: string | null;
  performed_by: string | null;
  performed_at: string;
  metadata: Record<string, unknown> | null;
}

export interface Notification {
  id: string;
  recipient_type: 'customer' | 'merchant' | 'admin';
  recipient_id: string;
  channel: NotificationChannel;
  template_id: string;
  to_address: string;
  provider: string | null;
  status: NotificationStatus;
  provider_message_id: string | null;
  failure_reason: string | null;
  queued_at: string;
  sent_at: string | null;
  delivered_at: string | null;
  failed_at: string | null;
}

export interface TelcoHealth {
  telco: MomoProvider;
  attempts: number;
  successes: number;
  failures: number;
  /** 0..1, or null when there are too few attempts to judge. */
  successRate: number | null;
  status: TelcoHealthStatus;
}

// --- Settlement / merchant-dashboard view models ----------------------------

export interface MerchantBalances {
  merchantId: string;
  payablePesewas: number;
  reserveHeldPesewas: number;
  lifetimeSettledPesewas: number;
  openReservesCount: number;
  activePlans: number;
}

/** One day of trading, for the merchant analytics bar chart. */
export const GHANA_CARD_STATUSES = ['submitted', 'approved', 'rejected'] as const;
export type GhanaCardStatus = (typeof GHANA_CARD_STATUSES)[number];

/** What a customer is shown about their own Ghana Card. */
export interface GhanaCardStatusView {
  /** `null` until a card has been sent at all. */
  status: GhanaCardStatus | null;
  /** `GHA-•••••6789-0` — enough to recognise, useless to impersonate. */
  card_number_masked: string | null;
  has_scan: boolean;
  verified: boolean;
  verified_at: string | null;
  reviewed_at: string | null;
  /** Set only on a rejection, and the thing the customer has to act on. */
  rejection_reason: string | null;
  kyc_tier: number;
}

export interface MerchantStatsDay {
  /** `YYYY-MM-DD`, UTC — which for Ghana (UTC+0, no DST) is the local day. */
  date: string;
  orders: number;
  grossSoldPesewas: number;
}

/** One side of the payment-type split. */
export interface MerchantStatsByPaymentType {
  orders: number;
  grossSoldPesewas: number;
  averageBasketPesewas: number;
  /** Share of the period's orders. `null` when the period sold nothing. */
  shareOfOrdersPct: number | null;
}

/** Instalments versus paid outright, over the same orders as the headline. */
export interface MerchantStatsPaymentMix {
  installment: MerchantStatsByPaymentType;
  full: MerchantStatsByPaymentType;
}

export interface MerchantStatsPeriod {
  from: string;
  to: string;
  /** Placed in the period, less anything since cancelled or returned. */
  grossSoldPesewas: number;
  orders: number;
  averageBasketPesewas: number;
  /** What the ledger says is the merchant's, on this period's sales. */
  netEarnedPesewas: number;
  /** Everything credited to the merchant in the period, whatever it was for. */
  creditedPesewas: number;
  /** All pre-payment: a paid order cannot be cancelled, only refunded. */
  cancelledOrders: number;
  cancelledValuePesewas: number;
  /** The two sides always add up to `orders` and `grossSoldPesewas`. */
  paymentMix: MerchantStatsPaymentMix;
}

/** `null` where the previous period was zero — there is no change from nothing. */
export interface MerchantStatsChange {
  grossSoldPct: number | null;
  ordersPct: number | null;
  averageBasketPct: number | null;
  netEarnedPct: number | null;
}

// --- The merchant app's credit plans -----------------------------------------

/**
 * The seller's plan buckets. `late` is NOT a status: a plan whose customer has
 * missed a payment stays `active`, and the arrears live on the schedule.
 */
export const MERCHANT_PLAN_BUCKETS = ['active', 'late', 'completed', 'all'] as const;
export type MerchantPlanBucket = (typeof MERCHANT_PLAN_BUCKETS)[number];
export type MerchantPlanCounts = Record<MerchantPlanBucket, number>;

export interface MerchantPlanInstallment {
  sequence_number: number;
  due_date: string;
  amount_due_pesewas: number;
  amount_paid_pesewas: number;
  late_fee_pesewas: number;
  status: InstallmentStatus;
  paid_at: string | null;
}

export interface MerchantPlanRow {
  id: string;
  status: CustomerPlanStatus;
  business_model: BusinessModel;
  /** The sale, resolved through the order. Null once the order is gone. */
  orderId: string | null;
  orderNumber: string | null;
  itemSummary: string | null;
  customerName: string | null;
  orderAmountPesewas: number;
  totalPayablePesewas: number;
  /** Summed off the schedule, so it reconciles with the rows on the detail. */
  collectedPesewas: number;
  paidCount: number;
  /** Payments the customer makes, deposit INCLUDED. */
  installmentCount: number;
  nextDueDate: string | null;
  /** Derived from the schedule; there is no late plan status. */
  late: boolean;
  reserveOutstandingPesewas: number;
  createdAt: string;
}

export interface MerchantPlanPage {
  rows: MerchantPlanRow[];
  total: number;
}

export interface MerchantPlanDetail extends MerchantPlanRow {
  installments: MerchantPlanInstallment[];
  /** What the ledger credited, not a recomputation from the rate. */
  settledPesewas: number;
  mdrPesewas: number;
  reserveWithheldPesewas: number;
  /** `null` while the plan is still running. */
  reserveReleasesAt: string | null;
  mdrBps: number;
  reserveBps: number;
}

// --- The merchant app's order queue and order sheet --------------------------

/**
 * One entry in an order's history.
 *
 * `order_events` is written by every path that moves an order and, until the
 * merchant order sheet, was only ever read by the shopper's tracking screen —
 * so this is its first appearance in the shared types.
 */
export interface OrderEvent {
  id: string;
  order_id: string;
  event_type: string;
  /** The order status this event took it to, where the event changed one. */
  status: string | null;
  label: string;
  detail: string | null;
  occurred_at: string;
  created_at: string;
}

/** The buyer, as the seller is allowed to see them: enough to address a parcel. */
export interface MerchantOrderBuyer {
  id: string;
  name: string;
  phone: string;
}

/**
 * Where the order is going. Every field is nullable: `shipping_address_id` is
 * `ON DELETE SET NULL`, so an order that has already shipped can lose its
 * address, and a pickup order never had one.
 */
export interface MerchantOrderDelivery {
  method: FulfilmentMethod;
  recipient: string | null;
  phone: string | null;
  region: string | null;
  city: string | null;
  area: string | null;
  landmark: string | null;
  ghanapost_gps: string | null;
  hub_name: string | null;
  hub_detail: string | null;
}

/** What one order was worth to the seller, read out of the ledger, not recomputed. */
export interface MerchantOrderSettlement {
  grossPesewas: number;
  feePesewas: number;
  feeLabel: 'commission' | 'mdr';
  feeBps: number | null;
  reservePesewas: number;
  reserveBps: number | null;
  netPesewas: number;
  /** `null` before anything has been booked — not a settlement of zero. */
  bookedAt: string | null;
  reserveOutstandingPesewas: number;
  /** `null` while the plan is still running; the release clock has not started. */
  reserveReleasesAt: string | null;
}

export interface MerchantOrderInstallment {
  sequence_number: number;
  due_date: string;
  amount_due_pesewas: number;
  amount_paid_pesewas: number;
  status: InstallmentStatus;
  paid_at: string | null;
}

/**
 * The credit plan behind a financed order. `installments.length` counts the
 * deposit; `number_of_installments` on the plan does not.
 */
export interface MerchantOrderPlan {
  id: string;
  status: CustomerPlanStatus;
  business_model: BusinessModel;
  mdr_bps: number;
  reserve_bps: number;
  total_payable_pesewas: number;
  outstanding_pesewas: number;
  collectedPesewas: number;
  paidCount: number;
  installments: MerchantOrderInstallment[];
  nextDueDate: string | null;
  /** Derived from the schedule: there is no late plan status. */
  late: boolean;
}

export interface MerchantOrderRow extends Order {
  items: OrderItem[];
  buyer_name: string | null;
  buyer_phone: string | null;
  /** `null` where nothing has been booked yet. */
  settled_pesewas: number | null;
}

export interface MerchantOrderPage {
  rows: MerchantOrderRow[];
  /** Over the same bucket filter, not the whole queue. */
  total: number;
}

export interface MerchantOrderDetail extends Order {
  items: OrderItem[];
  buyer: MerchantOrderBuyer | null;
  delivery: MerchantOrderDelivery;
  settlement: MerchantOrderSettlement;
  plan: MerchantOrderPlan | null;
  /** The order's own history, oldest first. */
  events: OrderEvent[];
}

/**
 * The seller's queue buckets. Not order statuses: `new` is `paid` OR
 * `financing_active`, and `confirmed` is `fulfilling`.
 */
export const MERCHANT_ORDER_BUCKETS = [
  'new',
  'confirmed',
  'shipped',
  'delivered',
  'completed',
] as const;
export type MerchantOrderBucket = (typeof MERCHANT_ORDER_BUCKETS)[number];

/** `all` counts every order the seller has, cancelled and returned included. */
export type MerchantOrderCounts = Record<MerchantOrderBucket | 'all', number>;

/** A merchant's catalogue in five numbers, for the home screen and the tab chips. */
export interface MerchantCatalogSummary {
  products: number;
  liveProducts: number;
  variants: number;
  /** Active variants of undeleted products with nothing on the shelf. */
  outOfStockVariants: number;
  /** At or below the variant's own restock threshold, but not yet at zero. */
  lowStockVariants: number;
}

/** One product's contribution to the window, for the "Best sellers" list. */
export interface MerchantStatsTopProduct {
  /** `null` once the catalogue row is gone; the sale still counts. */
  productId: string | null;
  title: string;
  unitsSold: number;
  grossSoldPesewas: number;
  /** Across the product's whole range. `null` when there is nothing to read. */
  stockAvailable: number | null;
}

export interface MerchantStats {
  merchantId: string;
  windowDays: MerchantStatsWindow;
  generatedAt: string;
  current: MerchantStatsPeriod;
  previous: MerchantStatsPeriod;
  change: MerchantStatsChange;
  daily: MerchantStatsDay[];
  /** `current`'s best sellers by units, most sold first. At most 5. */
  topProducts: MerchantStatsTopProduct[];
}

export interface MerchantPayoutRow {
  id: string;
  reference: string;
  asOfDate: string;
  amountPesewas: number;
  status: PayoutStatus;
  paystackTransferCode: string | null;
  initiatedAt: string;
  settledAt: string | null;
  failedAt: string | null;
  lastError: string | null;
}

export interface MerchantPayoutsPage {
  rows: MerchantPayoutRow[];
  total: number;
}

export interface MerchantHeldReserveRow {
  id: string;
  customerPlanId: string;
  /**
   * The sale the reserve was withheld from, where the order still exists.
   *
   * A reserve row knows its plan and nothing else, which left the seller
   * reading a list of uuids and cedi amounts with no way to tell which sale
   * each one came from. Null when the order has been deleted — the reserve
   * outlives it.
   */
  orderNumber: string | null;
  /** The first line of that order, for a row a seller can recognise. */
  itemSummary: string | null;
  businessModel: BusinessModel;
  amountPesewas: number;
  releasedPesewas: number;
  consumedForDefaultPesewas: number;
  outstandingPesewas: number;
  heldAt: string;
  planCompletedAt: string | null;
  deliveredAt: string | null;
  releasableFrom: string | null;
  fullyReleasedAt: string | null;
}

export interface PlanSettlementView {
  customerPlanId: string;
  merchantId: string;
  businessModel: BusinessModel;
  orderAmountPesewas: number;
  status: CustomerPlanStatus;
  grossAccruedPesewas: number;
  refundedPesewas: number;
  reserveHeldPesewas: number;
  defaultWrittenOffPesewas: number;
  defaultClawedFromMerchantPesewas: number;
  defaultConsumedFromReservePesewas: number;
}

// --- Statements & receipts (GHS-formatted string fields) --------------------

export interface StatementLine {
  sequenceNumber: number;
  dueDate: string;
  amountDue: string;
  amountPaid: string;
  status: InstallmentStatus;
  paidAt: string | null;
}

export interface Statement {
  generatedAt: string;
  planId: string;
  applicationId: string;
  customerName: string;
  merchantName: string | null;
  businessModel: BusinessModel;
  status: CustomerPlanStatus;
  summary: {
    orderAmount: string;
    downPayment: string;
    financedAmount: string;
    totalInterest: string;
    totalFees: string;
    totalPayable: string;
    amountPaid: string;
    outstanding: string;
    installmentCount: number;
  };
  lines: StatementLine[];
}

export interface MerchantStatementLine {
  occurredAt: string;
  date: string;
  transactionId: string;
  description: string;
  direction: LedgerDirection;
  amount: string;
  signedAmountPesewas: number;
  kind:
    | 'accrual'
    | 'reserve_release'
    | 'payout'
    | 'payout_reversal'
    | 'default_clawback'
    | 'refund_reversal'
    | 'other';
}

export interface MerchantStatement {
  generatedAt: string;
  merchantId: string;
  merchantName: string | null;
  period: string;
  periodStart: string;
  periodEnd: string;
  summary: {
    openingBalance: string;
    closingBalance: string;
    totalCredited: string;
    totalDebited: string;
    reserveReleased: string;
    paidOut: string;
    lineCount: number;
  };
  lines: MerchantStatementLine[];
}

// --- Commerce (catalog) -----------------------------------------------------
// Rows returned by the @installment/commerce services (stores, categories,
// products, variants, images, inventory, plan offers). Money is integer
// pesewas; the internal products.search_tsv column is never surfaced.

export interface Store {
  id: string;
  merchant_id: string;
  slug: string;
  display_name: string;
  about: string | null;
  logo_key: string | null;
  banner_key: string | null;
  support_email: string | null;
  support_phone: string | null;
  /**
   * Where the shop trades. Read by the storefront long before anything could
   * write them — no schema accepted either field until the seller app needed
   * to ask for them at shop setup.
   */
  city: string | null;
  region: string | null;
  /** What the shop mainly sells: a top-level `categories` row, or null. */
  primary_category_id: string | null;
  status: StoreStatus;
  policies: Record<string, unknown>;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface Category {
  id: string;
  parent_id: string | null;
  name: string;
  slug: string;
  position: number;
  is_active: boolean;
  created_at: string;
}

export interface Product {
  id: string;
  store_id: string;
  merchant_id: string;
  category_id: string | null;
  title: string;
  description: string | null;
  status: ProductStatus;
  base_price_pesewas: number;
  /**
   * The "was" price, always strictly above `base_price_pesewas` — the table's
   * `products_compare_at_above_price` CHECK sees to that, so a client can
   * render the strikethrough on this field's presence alone.
   */
  compare_at_price_pesewas: number | null;
  /** When the sale ends. Never set without a "was" price to count down from. */
  deal_ends_at: string | null;
  currency: 'GHS';
  attributes: Record<string, unknown>;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/**
 * Every field `Product` declares, as a runtime list.
 *
 * The mirror spec compares this to the server's own `productCols`, and it
 * exists because a hand-written interface is the one kind of drift that gate
 * cannot otherwise see: vitest runs through esbuild, which strips type
 * annotations without checking them, so a structural assertion between two
 * types passes no matter what either says.
 *
 * It caught a real one on arrival — `compare_at_price_pesewas`, `deal_ends_at`,
 * `updated_at` and `deleted_at` were all being returned by the API and declared
 * by nothing, so the seller's own edit screen could not see the sale it was
 * supposed to edit.
 *
 * `satisfies` keeps the list honest in the other direction: a name here that is
 * not a key of `Product` fails to compile.
 */
export const PRODUCT_FIELDS = [
  'id',
  'store_id',
  'merchant_id',
  'category_id',
  'title',
  'description',
  'status',
  'base_price_pesewas',
  'compare_at_price_pesewas',
  'deal_ends_at',
  'currency',
  'attributes',
  'metadata',
  'created_at',
  'updated_at',
  'deleted_at',
] as const satisfies readonly (keyof Product)[];

export interface ProductVariant {
  id: string;
  product_id: string;
  sku: string;
  option_values: Record<string, unknown>;
  /** null → use the product's base_price_pesewas. */
  price_pesewas: number | null;
  barcode: string | null;
  is_active: boolean;
  created_at: string;
}

export interface ProductImage {
  id: string;
  product_id: string;
  storage_key: string;
  alt_text: string | null;
  position: number;
  created_at: string;
}

export interface Inventory {
  id: string;
  variant_id: string;
  quantity_available: number;
  quantity_reserved: number;
  restock_threshold: number;
  created_at: string;
}

export interface ProductPlanOffer {
  id: string;
  product_id: string;
  plan_template_id: string;
  is_active: boolean;
  created_at: string;
}

/** Composed view returned by GET /admin/products/:id and the storefront. */
export interface ProductDetails extends Product {
  variants: Array<ProductVariant & { inventory: Inventory | null }>;
  images: ProductImage[];
  plan_template_ids: string[];
}

/**
 * The merchant portal's own read models.
 *
 * Identical to the admin ones but for resolved URLs: `storage_key` is a bucket
 * path, and a client that rebuilt the URL itself would have to change the day
 * storage moves behind a CDN or starts signing. `null` where the deployment has
 * no storage configured — which renders as the placeholder tile rather than a
 * broken image.
 */
export interface MerchantProductImage extends ProductImage {
  url: string | null;
}

/** GET/PATCH /merchant/store — the store with its artwork keys resolved. */
export interface MerchantStore extends Store {
  logo_url: string | null;
  banner_url: string | null;
}

/** One buyable variant of a product, with what is on the shelf. */
export interface ProductVariantStock {
  id: string;
  sku: string;
  /** `{"size":"L"}` — whatever the seller named their options. */
  option_values: Record<string, unknown>;
  /** `null` means the variant sells at the product's base price. */
  price_pesewas: number | null;
  quantity_available: number;
  restock_threshold: number;
}

export interface MerchantProductRow extends Product {
  primary_image_url: string | null;
  /**
   * Active variants only, with stock. Comes with the page so a catalogue of
   * thirty cards is one request rather than thirty-one.
   */
  variants: ProductVariantStock[];
}

export interface MerchantProductDetails extends Omit<ProductDetails, 'images'> {
  images: MerchantProductImage[];
}

// --- Commerce (cart & addresses) --------------------------------------------

export interface Address {
  id: string;
  customer_id: string;
  recipient: string;
  phone: string;
  region: string;
  city: string;
  area: string | null;
  landmark: string | null;
  ghanapost_gps: string | null;
  is_default: boolean;
  created_at: string;
}

export interface Cart {
  id: string;
  customer_id: string;
  status: CartStatus;
  created_at: string;
}

export interface CartItem {
  id: string;
  cart_id: string;
  variant_id: string;
  merchant_id: string;
  quantity: number;
  /** Price snapshotted onto the line when the item was added. */
  unit_price_pesewas: number;
  created_at: string;
}

/**
 * A cart line with the product details needed to render it. Read live from the
 * catalog rather than snapshotted: a cart is a current intention, so a renamed
 * product shows its new name. (Orders are the opposite — `OrderItem` snapshots
 * title and sku, because a purchase is a historical record.)
 */
export interface CartLine extends CartItem {
  title: string;
  sku: string;
  product_id: string | null;
}

/** Returned by GET /me/cart and the cart mutation endpoints. */
export interface CartWithItems extends Cart {
  items: CartLine[];
  subtotal_pesewas: number;
}

// --- Commerce (orders) ------------------------------------------------------

export interface Order {
  id: string;
  order_number: string;
  customer_id: string;
  merchant_id: string;
  store_id: string;
  source: OrderSource;
  payment_type: PaymentType;
  subtotal_pesewas: number;
  shipping_pesewas: number;
  discount_pesewas: number;
  total_pesewas: number;
  /** Marketplace take-rate applied to full orders, in basis points (0 for installment). */
  commission_bps: number;
  currency: 'GHS';
  status: OrderStatus;
  shipping_address_id: string | null;
  /** Set for installment orders — the engine application (order_reference = order.id). */
  application_id: string | null;
  /** Set once financing activates. */
  customer_plan_id: string | null;
  placed_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  /** Provider reference for the charge, once one has been attempted. */
  payment_reference: string | null;
  fulfilment_method: FulfilmentMethod;
  /** Set when `fulfilment_method` is `pickup`. */
  pickup_hub_id: string | null;
  /** Days the buyer has to return after delivery; the merchant's payout clock. */
  return_window_days: number;
  delivered_at: string | null;
  /** Stamped at delivery from `return_window_days`, never recomputed. */
  return_window_ends_at: string | null;
}

export interface OrderItem {
  id: string;
  order_id: string;
  /** Nulled if the variant/product is later removed; the snapshot below survives. */
  variant_id: string | null;
  product_id: string | null;
  title: string;
  sku: string;
  quantity: number;
  unit_price_pesewas: number;
  line_total_pesewas: number;
  created_at: string;
}

/** Returned by POST /me/checkout and the order read endpoints. */
export interface OrderWithItems extends Order {
  items: OrderItem[];
}
