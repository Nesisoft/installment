// Domain enums mirrored from the backend CHECK constraints
// (packages/db/drizzle/_introspect/schema.ts). Keep in sync if the DB changes.

export type BusinessModel = 'bnpl' | 'layaway' | 'hybrid' | 'rent_to_own';

export type UserType = 'system' | 'admin' | 'agent' | 'customer' | 'merchant';

export type MerchantStatus = 'pending_kyc' | 'active' | 'suspended' | 'offboarded';
export type MerchantTransitionEvent = 'activate' | 'suspend' | 'reactivate' | 'offboard';

export type MomoProvider = 'mtn' | 'tgo' | 'vod';

export type ApplicationStatus =
  | 'pending'
  | 'approved'
  | 'declined'
  | 'counter_offered'
  | 'manual_review'
  | 'expired'
  | 'cancelled';

export type DecisionOutcome =
  | 'approved'
  | 'approved_tier_2'
  | 'counter_offer'
  | 'manual_review'
  | 'declined';

export type RiskBand = 'prime' | 'near_prime' | 'subprime' | 'unscorable';

export type RuleCategory = 'hard_gate' | 'score' | 'exposure';

export type CustomerPlanStatus =
  | 'active'
  | 'completed'
  | 'defaulted'
  | 'cancelled'
  | 'restructured';

export type InstallmentStatus =
  | 'pending'
  | 'due'
  | 'processing'
  | 'paid'
  | 'failed'
  | 'retry_scheduled'
  | 'overdue'
  | 'in_collections'
  | 'restructured'
  | 'defaulted'
  | 'waived'
  | 'refunded';

export type InstallmentFrequencyDays = 7 | 14 | 30;

export type PaymentAttemptStatus = 'in_flight' | 'unknown' | 'succeeded' | 'failed';
export type PaymentProvider = 'paystack' | 'manual';
export type PaymentChannel = 'auto_debit' | 'payment_link' | 'manual_entry';
export type PaymentMethod = 'momo' | 'card' | 'bank_transfer';

export type PayoutStatus =
  | 'initiated'
  | 'pending_confirmation'
  | 'settled'
  | 'failed'
  | 'unknown'
  | 'reversed';

export type RefundStatus =
  | 'initiated'
  | 'pending_confirmation'
  | 'succeeded'
  | 'failed'
  | 'unknown';
export type RefundMethod = 'paystack' | 'manual';

export type CollectionsStage =
  | 'soft_reminder'
  | 'firm_reminder'
  | 'restriction_warning'
  | 'agent_assigned'
  | 'field_visit'
  | 'legal_threat'
  | 'write_off';

export type CollectionsResolution =
  | 'paid'
  | 'restructured'
  | 'defaulted'
  | 'written_off'
  | 'waived';

export type CollectionsActionType =
  | 'sms_sent'
  | 'email_sent'
  | 'call_made'
  | 'visit_scheduled'
  | 'visit_completed'
  | 'note_added'
  | 'stage_changed';

export type EmployerStatus = 'pending' | 'active' | 'paused' | 'terminated';
export type EmployerSector = 'public' | 'private' | 'ngo' | 'university';
export type PayrollCycle = 'weekly' | 'biweekly' | 'monthly';
export type EmploymentStatus = 'active' | 'left_employer' | 'on_leave' | 'suspended';
export type SalaryBand = 'unknown' | 'low' | 'mid' | 'high';

export type NotificationChannel = 'sms' | 'email' | 'push' | 'in_app';
export type NotificationStatus = 'queued' | 'sent' | 'delivered' | 'failed' | 'bounced';

export type LedgerDirection = 'debit' | 'credit';
export type LedgerAccountType =
  | 'paystack_settlement'
  | 'merchant_payable'
  | 'reserve_held'
  | 'default_pool'
  | 'revenue'
  | 'receivable'
  | 'refund_payable'
  | 'customer_float';

export type TelcoHealthStatus = 'healthy' | 'degraded' | 'down' | 'unknown';

// --- Commerce (catalog) -----------------------------------------------------
export type StoreStatus = 'draft' | 'active' | 'suspended';
export type StoreTransitionEvent = 'activate' | 'suspend' | 'unsuspend';
export type ProductStatus = 'draft' | 'active' | 'archived';
export type CartStatus = 'active' | 'converted' | 'abandoned';

// --- Commerce (orders) ------------------------------------------------------
export type PaymentType = 'full' | 'installment';
export type OrderSource = 'internal' | 'partner';
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

// RBAC permissions (packages/core/src/shared/auth/permissions.ts +
// packages/commerce/src/permissions.ts).
export const PERMISSIONS = [
  'merchants:read',
  'merchants:write',
  'customers:read',
  'customers:write',
  'employers:read',
  'employers:write',
  'applications:review',
  'collections:act',
  'plans:read',
  'plans:write',
  'plans:deliver',
  'settlements:run',
  'refunds:act',
  'users:write',
  'audit:read',
  'catalog:read',
  'catalog:write',
  'categories:write',
] as const;

export type Permission = (typeof PERMISSIONS)[number];
