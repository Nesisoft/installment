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
  default_mdr_bps: number;
  default_reserve_bps: number;
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

export interface Customer {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  date_of_birth: string | null;
  ghana_card_number: string | null;
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

export interface Application {
  id: string;
  customer_id: string;
  merchant_id: string;
  plan_template_id: string;
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
    paystackTransactionCount: number;
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
  currency: 'GHS';
  attributes: Record<string, unknown>;
  metadata: Record<string, unknown>;
  created_at: string;
}

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

/** Returned by GET /me/cart and the cart mutation endpoints. */
export interface CartWithItems extends Cart {
  items: CartItem[];
  subtotal_pesewas: number;
}
