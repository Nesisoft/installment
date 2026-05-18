-- ============================================================================
-- 0001_installment_engine_init.sql
-- ============================================================================
-- Initial schema for the Installment Payment Engine.
--
-- Conventions:
--   * PKs and FKs defined INLINE (per Mr. Anlimah's preference)
--   * Money stored as BIGINT in pesewas (GHS × 100) — never floats
--   * Timestamps with time zone, all in UTC
--   * Soft-delete via deleted_at where applicable (audit-friendly)
--   * Append-only tables noted explicitly — no UPDATE/DELETE in code
--   * CHECK constraints encode invariants the application also enforces
--   * Indexes follow query patterns from the four prior modules
--
-- ACTOR-ID CONVENTION (important — read before writing application code):
--   This migration does NOT create a `users` table. Columns that reference
--   a user (assigned_agent_id, performed_by, created_by, actor_id, etc.)
--   are stored as plain UUID or TEXT without FK constraints.
--
--   Until 0002_users_and_rbac.sql runs, the application uses SENTINEL UUIDs
--   for system actors. The reserved range is:
--     00000000-0000-0000-0000-00000000000X  →  system actors
--     aaaaaaaa-aaaa-aaaa-aaaa-000000000XXX  →  test fixture users
--
--   Canonical system actor UUIDs (must match users seed in 0002):
--     SYSTEM              00000000-0000-0000-0000-000000000001
--     SCHEDULER           00000000-0000-0000-0000-000000000002
--     DEBIT_WORKER        00000000-0000-0000-0000-000000000003
--     WEBHOOK             00000000-0000-0000-0000-000000000004
--     RECONCILER          00000000-0000-0000-0000-000000000005
--     COLLECTIONS_BOT     00000000-0000-0000-0000-000000000006
--     SETTLEMENT_WORKER   00000000-0000-0000-0000-000000000007
--     VERIFY_WORKER       00000000-0000-0000-0000-000000000008
--     NOTIFICATION_WORKER 00000000-0000-0000-0000-000000000009
--     SEED_ADMIN          00000000-0000-0000-0000-000000000099
--
--   When 0002 runs, it MUST seed users with these exact IDs BEFORE adding
--   any FK constraints. Otherwise existing audit rows become orphaned.
--
--   NOTE: audit_events.actor_id is TEXT (not UUID) by design — it must
--   accept non-UUID values like 'paystack' for webhook actors. Do NOT add
--   an FK to that column even in 0002.
-- ============================================================================

BEGIN;

-- ============================================================================
-- EXTENSIONS
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "citext";     -- case-insensitive emails

-- ============================================================================
-- ENUMS
-- ============================================================================
-- Note: we use TEXT + CHECK constraints rather than native ENUMs to make
-- adding new values a single ALTER instead of an ENUM migration dance.
-- Enum-like values are defined as CHECK lists below per column.

-- ============================================================================
-- 1. MERCHANTS
-- ============================================================================

CREATE TABLE merchants (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_name               TEXT NOT NULL,
  legal_name                  TEXT NOT NULL,
  tin                         TEXT UNIQUE,                  -- Tax Identification Number
  registration_number         TEXT UNIQUE,                  -- Registrar General number
  email                       CITEXT NOT NULL UNIQUE,
  phone                       TEXT NOT NULL,

  -- Settlement
  paystack_recipient_code     TEXT,                         -- set after KYC
  bank_account_number         TEXT,
  bank_code                   TEXT,
  bank_account_name           TEXT,

  -- Configuration
  default_business_model      TEXT NOT NULL DEFAULT 'bnpl'
    CHECK (default_business_model IN ('bnpl', 'layaway', 'hybrid', 'rent_to_own')),
  default_mdr_bps             INTEGER NOT NULL DEFAULT 400  -- 4%
    CHECK (default_mdr_bps >= 0 AND default_mdr_bps <= 2000),
  default_reserve_bps         INTEGER NOT NULL DEFAULT 500  -- 5%
    CHECK (default_reserve_bps >= 0 AND default_reserve_bps <= 5000),

  -- Lifecycle
  status                      TEXT NOT NULL DEFAULT 'pending_kyc'
    CHECK (status IN ('pending_kyc', 'active', 'suspended', 'offboarded')),
  onboarded_at                TIMESTAMPTZ,
  suspended_at                TIMESTAMPTZ,
  suspension_reason           TEXT,

  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at                  TIMESTAMPTZ
);

CREATE INDEX merchants_status_idx ON merchants (status) WHERE deleted_at IS NULL;
CREATE INDEX merchants_email_idx ON merchants (email) WHERE deleted_at IS NULL;

COMMENT ON TABLE merchants IS 'Businesses that sell through the installment platform';
COMMENT ON COLUMN merchants.default_mdr_bps IS 'Merchant Discount Rate in basis points (400 = 4%)';
COMMENT ON COLUMN merchants.default_reserve_bps IS 'Reserve hold in basis points (500 = 5%)';

-- ============================================================================
-- 2. CUSTOMERS
-- ============================================================================

CREATE TABLE customers (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity
  first_name                  TEXT NOT NULL,
  last_name                   TEXT NOT NULL,
  email                       CITEXT NOT NULL UNIQUE,
  phone                       TEXT NOT NULL UNIQUE,
  date_of_birth               DATE,

  -- Ghana-specific identity
  ghana_card_number           TEXT UNIQUE,
  ghana_card_verified         BOOLEAN NOT NULL DEFAULT FALSE,
  ghana_card_verified_at      TIMESTAMPTZ,
  ghana_card_image_key        TEXT,                         -- S3 key

  -- Mobile Money preferences
  momo_phone                  TEXT,
  momo_provider               TEXT
    CHECK (momo_provider IS NULL OR momo_provider IN ('mtn', 'tgo', 'vod')),

  -- Compliance & risk
  kyc_tier                    SMALLINT NOT NULL DEFAULT 0
    CHECK (kyc_tier IN (0, 1, 2)),
  is_on_blocklist             BOOLEAN NOT NULL DEFAULT FALSE,
  blocklist_reason            TEXT,

  -- Consent (Ghana Data Protection Act)
  data_processing_consent_at  TIMESTAMPTZ,
  credit_scoring_consent_at   TIMESTAMPTZ,
  marketing_consent_at        TIMESTAMPTZ,

  -- Tracking
  phone_first_seen_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at               TIMESTAMPTZ,

  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at                  TIMESTAMPTZ
);

CREATE INDEX customers_phone_idx ON customers (phone) WHERE deleted_at IS NULL;
CREATE INDEX customers_kyc_tier_idx ON customers (kyc_tier) WHERE deleted_at IS NULL;
CREATE INDEX customers_blocklist_idx ON customers (is_on_blocklist) WHERE is_on_blocklist = TRUE;

-- ============================================================================
-- 3. EMPLOYERS (for salary-deducted plans)
-- ============================================================================

CREATE TABLE employers (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                        TEXT NOT NULL,
  sector                      TEXT
    CHECK (sector IS NULL OR sector IN ('public', 'private', 'ngo', 'university')),
  status                      TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'paused', 'terminated')),
  payroll_cycle               TEXT NOT NULL DEFAULT 'monthly'
    CHECK (payroll_cycle IN ('weekly', 'biweekly', 'monthly')),
  partnership_start_date      DATE,
  contact_email               CITEXT,
  contact_phone               TEXT,
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE customer_employment (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id                 UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  employer_id                 UUID NOT NULL REFERENCES employers(id),

  employee_number             TEXT,
  salary_band                 TEXT NOT NULL DEFAULT 'unknown'
    CHECK (salary_band IN ('unknown', 'low', 'mid', 'high')),
  employment_start_date       DATE,
  payroll_deduction_consent   BOOLEAN NOT NULL DEFAULT FALSE,
  consent_signed_at           TIMESTAMPTZ,

  status                      TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'left_employer', 'on_leave', 'suspended')),

  verified_at                 TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (customer_id, employer_id)
);

CREATE INDEX customer_employment_customer_idx ON customer_employment (customer_id);
CREATE INDEX customer_employment_employer_idx ON customer_employment (employer_id);

-- ============================================================================
-- 4. PLAN TEMPLATES
-- ============================================================================

CREATE TABLE plan_templates (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                        TEXT NOT NULL,
  description                 TEXT,
  business_model              TEXT NOT NULL
    CHECK (business_model IN ('bnpl', 'layaway', 'hybrid', 'rent_to_own')),

  -- Schedule structure
  number_of_installments      SMALLINT NOT NULL CHECK (number_of_installments BETWEEN 1 AND 24),
  installment_frequency_days  SMALLINT NOT NULL CHECK (installment_frequency_days IN (7, 14, 30)),
  down_payment_bps            INTEGER NOT NULL DEFAULT 0
    CHECK (down_payment_bps >= 0 AND down_payment_bps <= 10000),

  -- Pricing
  interest_rate_bps           INTEGER NOT NULL DEFAULT 0
    CHECK (interest_rate_bps >= 0 AND interest_rate_bps <= 10000),
  service_fee_flat_pesewas    BIGINT NOT NULL DEFAULT 0 CHECK (service_fee_flat_pesewas >= 0),
  late_fee_pesewas            BIGINT NOT NULL DEFAULT 0 CHECK (late_fee_pesewas >= 0),
  grace_period_days           SMALLINT NOT NULL DEFAULT 3 CHECK (grace_period_days BETWEEN 0 AND 14),

  -- Eligibility bounds
  min_amount_pesewas          BIGINT NOT NULL CHECK (min_amount_pesewas >= 0),
  max_amount_pesewas          BIGINT NOT NULL CHECK (max_amount_pesewas > 0),
  eligible_categories         TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  excluded_categories         TEXT[] NOT NULL DEFAULT '{}'::TEXT[],

  -- Lifecycle
  is_active                   BOOLEAN NOT NULL DEFAULT TRUE,
  effective_from              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  effective_to                TIMESTAMPTZ,

  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CHECK (max_amount_pesewas >= min_amount_pesewas),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE INDEX plan_templates_active_idx ON plan_templates (is_active, business_model)
  WHERE is_active = TRUE;

-- ============================================================================
-- 5. APPLICATIONS
-- ============================================================================

CREATE TABLE applications (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id                 UUID NOT NULL REFERENCES customers(id),
  merchant_id                 UUID NOT NULL REFERENCES merchants(id),
  plan_template_id            UUID NOT NULL REFERENCES plan_templates(id),

  order_reference             TEXT NOT NULL,                -- merchant's order ID
  order_amount_pesewas        BIGINT NOT NULL CHECK (order_amount_pesewas > 0),
  merchant_category           TEXT NOT NULL,

  -- Decision
  status                      TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'declined', 'counter_offered', 'manual_review', 'expired', 'cancelled')),
  decision_at                 TIMESTAMPTZ,
  declined_reason             TEXT,

  -- Counter-offer (when status = 'counter_offered')
  counter_down_payment_pesewas BIGINT CHECK (counter_down_payment_pesewas IS NULL OR counter_down_payment_pesewas >= 0),
  counter_financed_pesewas    BIGINT CHECK (counter_financed_pesewas IS NULL OR counter_financed_pesewas >= 0),

  expires_at                  TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (merchant_id, order_reference)
);

CREATE INDEX applications_customer_idx ON applications (customer_id, created_at DESC);
CREATE INDEX applications_merchant_idx ON applications (merchant_id, created_at DESC);
CREATE INDEX applications_status_idx ON applications (status) WHERE status IN ('pending', 'manual_review');
CREATE INDEX applications_pending_expiry_idx ON applications (expires_at) WHERE status = 'pending';

-- ============================================================================
-- 6. CREDIT PROFILES (append-only, immutable)
-- ============================================================================

CREATE TABLE credit_profiles (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id                 UUID NOT NULL REFERENCES customers(id),
  application_id              UUID REFERENCES applications(id),

  score                       INTEGER NOT NULL CHECK (score >= 0 AND score <= 1000),
  risk_band                   TEXT NOT NULL
    CHECK (risk_band IN ('prime', 'near_prime', 'subprime', 'unscorable')),
  outcome                     TEXT NOT NULL
    CHECK (outcome IN ('approved', 'approved_tier_2', 'counter_offer', 'manual_review', 'declined')),
  approved_limit_pesewas      BIGINT NOT NULL DEFAULT 0 CHECK (approved_limit_pesewas >= 0),

  ruleset_version             TEXT NOT NULL,
  rules_fired                 JSONB NOT NULL,               -- full rule result list
  features_snapshot           JSONB NOT NULL,               -- feature vector at decision time

  decided_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX credit_profiles_customer_idx ON credit_profiles (customer_id, decided_at DESC);
CREATE INDEX credit_profiles_application_idx ON credit_profiles (application_id);

COMMENT ON TABLE credit_profiles IS 'APPEND-ONLY. Every scoring decision is a new row.';

-- ============================================================================
-- 7. CUSTOMER PLANS — instances of a plan template assigned to a customer
-- ============================================================================

CREATE TABLE customer_plans (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id                 UUID NOT NULL REFERENCES customers(id),
  merchant_id                 UUID NOT NULL REFERENCES merchants(id),
  plan_template_id            UUID NOT NULL REFERENCES plan_templates(id),
  application_id              UUID NOT NULL REFERENCES applications(id),

  -- Frozen at approval time so template edits don't affect active plans
  business_model              TEXT NOT NULL
    CHECK (business_model IN ('bnpl', 'layaway', 'hybrid', 'rent_to_own')),
  number_of_installments      SMALLINT NOT NULL,
  installment_frequency_days  SMALLINT NOT NULL,
  grace_period_days           SMALLINT NOT NULL,
  mdr_bps                     INTEGER NOT NULL,
  reserve_bps                 INTEGER NOT NULL,

  -- Money breakdown
  order_amount_pesewas        BIGINT NOT NULL CHECK (order_amount_pesewas > 0),
  down_payment_pesewas        BIGINT NOT NULL DEFAULT 0 CHECK (down_payment_pesewas >= 0),
  financed_amount_pesewas     BIGINT NOT NULL CHECK (financed_amount_pesewas >= 0),
  total_interest_pesewas      BIGINT NOT NULL DEFAULT 0 CHECK (total_interest_pesewas >= 0),
  total_fees_pesewas          BIGINT NOT NULL DEFAULT 0 CHECK (total_fees_pesewas >= 0),
  total_payable_pesewas       BIGINT NOT NULL,              -- order + interest + fees
  outstanding_pesewas         BIGINT NOT NULL,              -- decremented as paid

  -- Lifecycle
  status                      TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'completed', 'defaulted', 'cancelled', 'restructured')),
  approved_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  activated_at                TIMESTAMPTZ,
  completed_at                TIMESTAMPTZ,
  defaulted_at                TIMESTAMPTZ,
  restructured_from_plan_id   UUID REFERENCES customer_plans(id),

  -- Delivery (for layaway/hybrid)
  product_delivered_at        TIMESTAMPTZ,

  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  version                     INTEGER NOT NULL DEFAULT 1,   -- optimistic concurrency
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CHECK (outstanding_pesewas >= 0),
  CHECK (outstanding_pesewas <= total_payable_pesewas),
  CHECK (down_payment_pesewas + financed_amount_pesewas = order_amount_pesewas)
);

CREATE INDEX customer_plans_customer_idx ON customer_plans (customer_id, status);
CREATE INDEX customer_plans_merchant_idx ON customer_plans (merchant_id, status);
CREATE INDEX customer_plans_active_idx ON customer_plans (status) WHERE status = 'active';

-- ============================================================================
-- 8. INSTALLMENT SCHEDULE — the heart of the system
-- ============================================================================

CREATE TABLE installment_schedule (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_plan_id            UUID NOT NULL REFERENCES customer_plans(id) ON DELETE RESTRICT,
  sequence_number             SMALLINT NOT NULL CHECK (sequence_number >= 1),

  -- Money
  amount_due_pesewas          BIGINT NOT NULL CHECK (amount_due_pesewas > 0),
  amount_paid_pesewas         BIGINT NOT NULL DEFAULT 0 CHECK (amount_paid_pesewas >= 0),
  late_fee_pesewas            BIGINT NOT NULL DEFAULT 0 CHECK (late_fee_pesewas >= 0),

  -- Scheduling
  due_date                    DATE NOT NULL,
  grace_until_date            DATE NOT NULL,

  -- State (the state machine!)
  status                      TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN (
      'pending', 'due', 'processing', 'paid',
      'failed', 'retry_scheduled',
      'overdue', 'in_collections',
      'restructured', 'defaulted', 'waived', 'refunded'
    )),
  status_changed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Attempt tracking
  attempt_count               SMALLINT NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_attempt_at             TIMESTAMPTZ,
  last_failure_reason         TEXT,
  next_retry_at               TIMESTAMPTZ,

  -- Resolution
  paid_at                     TIMESTAMPTZ,
  provider_reference          TEXT,

  -- Concurrency
  version                     INTEGER NOT NULL DEFAULT 1,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (customer_plan_id, sequence_number),
  CHECK (amount_paid_pesewas <= amount_due_pesewas + late_fee_pesewas),
  CHECK (grace_until_date >= due_date)
);

-- Queries the Debit Scheduler runs every hour
CREATE INDEX schedule_due_pickup_idx ON installment_schedule (due_date, status)
  WHERE status IN ('pending', 'due', 'retry_scheduled');

-- Reconciliation worker — find stuck processing schedules
CREATE INDEX schedule_stuck_idx ON installment_schedule (status, status_changed_at)
  WHERE status = 'processing';

-- Collections worker — find overdue items
CREATE INDEX schedule_overdue_idx ON installment_schedule (status, grace_until_date)
  WHERE status IN ('overdue', 'in_collections');

-- Customer dashboard — upcoming payments
CREATE INDEX schedule_customer_upcoming_idx ON installment_schedule (customer_plan_id, due_date)
  WHERE status IN ('pending', 'due');

COMMENT ON COLUMN installment_schedule.version IS 'Optimistic concurrency token — bumped on every state transition';

-- ============================================================================
-- 9. PAYMENT ATTEMPTS — immutable audit log
-- ============================================================================

CREATE TABLE payment_attempts (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id                 UUID NOT NULL REFERENCES installment_schedule(id),
  customer_plan_id            UUID NOT NULL REFERENCES customer_plans(id),

  -- Attempt details
  provider                    TEXT NOT NULL DEFAULT 'paystack'
    CHECK (provider IN ('paystack', 'manual')),
  channel                     TEXT NOT NULL
    CHECK (channel IN ('auto_debit', 'payment_link', 'manual_entry')),
  payment_method              TEXT
    CHECK (payment_method IS NULL OR payment_method IN ('momo', 'card', 'bank_transfer')),

  amount_pesewas              BIGINT NOT NULL CHECK (amount_pesewas > 0),
  idempotency_key             TEXT NOT NULL,
  provider_reference          TEXT,
  payment_link_url            TEXT,

  -- Outcome
  status                      TEXT NOT NULL DEFAULT 'in_flight'
    CHECK (status IN ('in_flight', 'unknown', 'succeeded', 'failed')),
  failure_reason              TEXT,
  raw_response                JSONB,

  -- Polling state
  verify_poll_count           SMALLINT NOT NULL DEFAULT 0,
  last_verified_at            TIMESTAMPTZ,

  -- Lifecycle
  initiated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at                  TIMESTAMPTZ,
  failed_at                   TIMESTAMPTZ,

  UNIQUE (idempotency_key)
);

CREATE INDEX payment_attempts_schedule_idx ON payment_attempts (schedule_id, initiated_at DESC);
CREATE INDEX payment_attempts_provider_ref_idx ON payment_attempts (provider_reference)
  WHERE provider_reference IS NOT NULL;
CREATE INDEX payment_attempts_in_flight_idx ON payment_attempts (status, initiated_at)
  WHERE status IN ('in_flight', 'unknown');

COMMENT ON TABLE payment_attempts IS 'APPEND-ONLY for audit. UPDATE allowed only for status transitions on the same row.';

-- ============================================================================
-- 10. WEBHOOK EVENTS — idempotency record
-- ============================================================================

CREATE TABLE webhook_events (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider                    TEXT NOT NULL CHECK (provider IN ('paystack')),
  provider_event_id           TEXT NOT NULL,
  event_type                  TEXT NOT NULL,
  payload                     JSONB NOT NULL,
  signature                   TEXT NOT NULL,
  received_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at                TIMESTAMPTZ,
  processing_error            TEXT,

  UNIQUE (provider, provider_event_id)
);

CREATE INDEX webhook_events_unprocessed_idx ON webhook_events (received_at)
  WHERE processed_at IS NULL;

-- ============================================================================
-- 11. LEDGER ENTRIES — double-entry bookkeeping (append-only)
-- ============================================================================

CREATE TABLE ledger_entries (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id              TEXT NOT NULL,                -- groups debit+credit pair
  account_type                TEXT NOT NULL
    CHECK (account_type IN (
      'paystack_settlement', 'merchant_payable', 'reserve_held',
      'default_pool', 'revenue', 'receivable', 'refund_payable'
    )),
  account_ref                 TEXT NOT NULL,                -- merchant_id, plan_id, etc.
  direction                   TEXT NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount_pesewas              BIGINT NOT NULL CHECK (amount_pesewas > 0),
  currency                    CHAR(3) NOT NULL DEFAULT 'GHS' CHECK (currency = 'GHS'),
  description                 TEXT NOT NULL,
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ledger_account_balance_idx ON ledger_entries (account_type, account_ref, occurred_at);
CREATE INDEX ledger_transaction_idx ON ledger_entries (transaction_id);

COMMENT ON TABLE ledger_entries IS 'APPEND-ONLY. Sum of debits = sum of credits per transaction_id, always.';

-- ============================================================================
-- 12. PAYOUTS — merchant settlement records
-- ============================================================================

CREATE TABLE payouts (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id                 UUID NOT NULL REFERENCES merchants(id),

  amount_pesewas              BIGINT NOT NULL CHECK (amount_pesewas > 0),
  as_of_date                  DATE NOT NULL,
  reference                   TEXT NOT NULL UNIQUE,

  -- Paystack transfer details
  paystack_transfer_code      TEXT,
  paystack_transfer_id        TEXT,

  status                      TEXT NOT NULL DEFAULT 'initiated'
    CHECK (status IN ('initiated', 'pending_confirmation', 'settled', 'failed', 'unknown', 'reversed')),
  last_error                  TEXT,

  initiated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at                  TIMESTAMPTZ,
  failed_at                   TIMESTAMPTZ,

  UNIQUE (merchant_id, as_of_date)
);

CREATE INDEX payouts_merchant_idx ON payouts (merchant_id, initiated_at DESC);
CREATE INDEX payouts_pending_idx ON payouts (status) WHERE status IN ('initiated', 'pending_confirmation', 'unknown');

-- ============================================================================
-- 13. HELD RESERVES — per-plan reserve tracking for release scheduling
-- ============================================================================

CREATE TABLE held_reserves (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id                 UUID NOT NULL REFERENCES merchants(id),
  customer_plan_id            UUID NOT NULL REFERENCES customer_plans(id),
  business_model              TEXT NOT NULL
    CHECK (business_model IN ('bnpl', 'layaway', 'hybrid', 'rent_to_own')),

  amount_pesewas              BIGINT NOT NULL CHECK (amount_pesewas > 0),
  released_amount_pesewas     BIGINT NOT NULL DEFAULT 0 CHECK (released_amount_pesewas >= 0),

  -- Release policy triggers
  held_at                     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  plan_completed_at           TIMESTAMPTZ,
  delivered_at                TIMESTAMPTZ,
  last_release_at             TIMESTAMPTZ,
  fully_released_at           TIMESTAMPTZ,

  -- Default consumption
  consumed_for_default_pesewas BIGINT NOT NULL DEFAULT 0,

  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CHECK (released_amount_pesewas + consumed_for_default_pesewas <= amount_pesewas)
);

CREATE INDEX held_reserves_merchant_idx ON held_reserves (merchant_id, fully_released_at)
  WHERE fully_released_at IS NULL;
CREATE INDEX held_reserves_plan_idx ON held_reserves (customer_plan_id);

-- ============================================================================
-- 14. COLLECTIONS CASES
-- ============================================================================

CREATE TABLE collections_cases (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_plan_id            UUID NOT NULL REFERENCES customer_plans(id),
  schedule_id                 UUID REFERENCES installment_schedule(id),

  current_stage               TEXT NOT NULL DEFAULT 'soft_reminder'
    CHECK (current_stage IN (
      'soft_reminder', 'firm_reminder', 'restriction_warning',
      'agent_assigned', 'field_visit', 'legal_threat', 'write_off'
    )),
  stage_entered_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  assigned_agent_id           UUID,                         -- pending FK to users(id) in 0002. Use SYSTEM_ACTORS.COLLECTIONS_BOT for automated stages.

  opened_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at                   TIMESTAMPTZ,
  resolution                  TEXT
    CHECK (resolution IS NULL OR resolution IN ('paid', 'restructured', 'defaulted', 'written_off', 'waived')),

  amount_recovered_pesewas    BIGINT NOT NULL DEFAULT 0,
  notes                       TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX collections_cases_open_idx ON collections_cases (current_stage, opened_at)
  WHERE closed_at IS NULL;
CREATE INDEX collections_cases_agent_idx ON collections_cases (assigned_agent_id)
  WHERE closed_at IS NULL;

CREATE TABLE collections_actions (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id                     UUID NOT NULL REFERENCES collections_cases(id) ON DELETE CASCADE,
  action_type                 TEXT NOT NULL
    CHECK (action_type IN ('sms_sent', 'email_sent', 'call_made', 'visit_scheduled', 'visit_completed', 'note_added', 'stage_changed')),
  channel                     TEXT,
  outcome                     TEXT,
  notes                       TEXT,
  performed_by                UUID,                         -- pending FK to users(id) in 0002. Use SYSTEM_ACTORS.* for automated actions.
  performed_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX collections_actions_case_idx ON collections_actions (case_id, performed_at DESC);

-- ============================================================================
-- 15. AUDIT EVENTS — append-only state change log
-- ============================================================================

CREATE TABLE audit_events (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type                 TEXT NOT NULL,                -- 'installment_schedule', 'customer_plan', etc.
  entity_id                   UUID NOT NULL,

  event_type                  TEXT NOT NULL,                -- transition name
  from_state                  TEXT,
  to_state                    TEXT,

  actor_id                    TEXT NOT NULL,                -- TEXT (not UUID) by design. Accepts SYSTEM_ACTORS.* UUIDs, real user UUIDs, or string literals like 'paystack'. Never gets an FK constraint.
  actor_type                  TEXT NOT NULL
    CHECK (actor_type IN ('system', 'worker', 'admin', 'customer', 'webhook', 'merchant')),

  reason                      TEXT,
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX audit_events_entity_idx ON audit_events (entity_type, entity_id, occurred_at DESC);
CREATE INDEX audit_events_actor_idx ON audit_events (actor_id, occurred_at DESC);
CREATE INDEX audit_events_time_idx ON audit_events (occurred_at DESC);

COMMENT ON TABLE audit_events IS 'APPEND-ONLY. Every state transition writes one row, in the same transaction.';

-- ============================================================================
-- 16. NOTIFICATIONS — delivery tracking
-- ============================================================================

CREATE TABLE notifications (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_type              TEXT NOT NULL CHECK (recipient_type IN ('customer', 'merchant', 'admin')),
  recipient_id                UUID NOT NULL,
  channel                     TEXT NOT NULL CHECK (channel IN ('sms', 'email', 'push', 'in_app')),
  template_id                 TEXT NOT NULL,
  variables                   JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Routing
  to_address                  TEXT NOT NULL,                -- phone or email
  provider                    TEXT
    CHECK (provider IS NULL OR provider IN ('hubtel', 'arkesel', 'sendgrid', 'postmark', 'fcm')),

  status                      TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sent', 'delivered', 'failed', 'bounced')),
  provider_message_id         TEXT,
  failure_reason              TEXT,

  queued_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at                     TIMESTAMPTZ,
  delivered_at                TIMESTAMPTZ,
  failed_at                   TIMESTAMPTZ
);

CREATE INDEX notifications_recipient_idx ON notifications (recipient_type, recipient_id, queued_at DESC);
CREATE INDEX notifications_pending_idx ON notifications (status, queued_at) WHERE status = 'queued';

-- ============================================================================
-- 17. IDEMPOTENCY KEYS — protects mutating endpoints
-- ============================================================================

CREATE TABLE idempotency_keys (
  key                         TEXT PRIMARY KEY,
  request_hash                TEXT NOT NULL,
  response_body               JSONB,
  response_status             SMALLINT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at                  TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours')
);

CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys (expires_at);

-- ============================================================================
-- 18. RULE DEFINITIONS — for hot-reloading scoring rules
-- ============================================================================

CREATE TABLE rule_definitions (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ruleset_version             TEXT NOT NULL,
  rule_id                     TEXT NOT NULL,
  category                    TEXT NOT NULL CHECK (category IN ('hard_gate', 'score', 'exposure')),
  description                 TEXT NOT NULL,
  configuration               JSONB NOT NULL,               -- weights, thresholds, etc.

  is_active                   BOOLEAN NOT NULL DEFAULT TRUE,
  effective_from              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  effective_to                TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by                  UUID,                         -- pending FK to users(id) in 0002. Use SYSTEM_ACTORS.SEED_ADMIN for migration seeds.

  UNIQUE (ruleset_version, rule_id)
);

CREATE INDEX rule_definitions_active_idx ON rule_definitions (ruleset_version, is_active)
  WHERE is_active = TRUE;

-- ============================================================================
-- 19. UPDATED_AT TRIGGERS
-- ============================================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER merchants_updated_at BEFORE UPDATE ON merchants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER customers_updated_at BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER employers_updated_at BEFORE UPDATE ON employers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER customer_employment_updated_at BEFORE UPDATE ON customer_employment
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER plan_templates_updated_at BEFORE UPDATE ON plan_templates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER applications_updated_at BEFORE UPDATE ON applications
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER customer_plans_updated_at BEFORE UPDATE ON customer_plans
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER installment_schedule_updated_at BEFORE UPDATE ON installment_schedule
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER held_reserves_updated_at BEFORE UPDATE ON held_reserves
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER collections_cases_updated_at BEFORE UPDATE ON collections_cases
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- 20. APPEND-ONLY ENFORCEMENT (defense in depth)
-- ============================================================================

CREATE OR REPLACE FUNCTION block_modification()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Table % is append-only; UPDATE/DELETE not permitted', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER credit_profiles_immutable
  BEFORE UPDATE OR DELETE ON credit_profiles
  FOR EACH ROW EXECUTE FUNCTION block_modification();

CREATE TRIGGER ledger_entries_immutable
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION block_modification();

CREATE TRIGGER audit_events_immutable
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION block_modification();

-- ============================================================================
-- 21. DOUBLE-ENTRY BALANCE ENFORCEMENT
-- ============================================================================
-- Deferred constraint: at COMMIT time, every transaction_id in ledger_entries
-- must have sum(credit) = sum(debit). Implemented as a function called from
-- the application layer (LedgerService.record), not enforced by DB constraint
-- because PostgreSQL deferred constraints don't easily span aggregate checks.
-- The application MUST be the only writer to ledger_entries.

COMMIT;

-- ============================================================================
-- POST-MIGRATION NOTES
-- ============================================================================
--
-- 1. Run analyze immediately so the planner has stats:
--    ANALYZE;
--
-- 2. Configure pgBouncer for the worker pool (target ~50% of max_connections)
--
-- 3. Set up daily pg_dump + WAL archiving for PITR
--
-- 4. Recommended PostgreSQL settings for an OLTP workload like this:
--    shared_buffers = 25% of RAM
--    effective_cache_size = 75% of RAM
--    work_mem = 16MB
--    maintenance_work_mem = 256MB
--    wal_level = replica (or higher for PITR)
--    max_wal_size = 4GB
--    random_page_cost = 1.1 (if on SSD)
--
-- 5. Tables to monitor for bloat / vacuum tuning:
--    - installment_schedule (high UPDATE volume due to state transitions)
--    - payment_attempts (steady INSERT volume)
--    - notifications (steady INSERT, infrequent UPDATE)
--    - audit_events, ledger_entries (INSERT-only, no bloat)
--
-- 6. Consider partitioning these tables once they exceed ~100M rows:
--    - audit_events (by month)
--    - ledger_entries (by month)
--    - notifications (by month)
--    - payment_attempts (by quarter)
--
-- ============================================================================
