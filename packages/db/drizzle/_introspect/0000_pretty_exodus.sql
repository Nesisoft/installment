-- Current sql file was generated after introspecting the database
-- If you want to run this migration please uncomment this code before executing migrations
/*
CREATE TABLE "schema_migrations" (
	"filename" text PRIMARY KEY NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"email" "citext" NOT NULL,
	"phone" text NOT NULL,
	"date_of_birth" date,
	"ghana_card_number" text,
	"ghana_card_verified" boolean DEFAULT false NOT NULL,
	"ghana_card_verified_at" timestamp with time zone,
	"ghana_card_image_key" text,
	"momo_phone" text,
	"momo_provider" text,
	"kyc_tier" smallint DEFAULT 0 NOT NULL,
	"is_on_blocklist" boolean DEFAULT false NOT NULL,
	"blocklist_reason" text,
	"data_processing_consent_at" timestamp with time zone,
	"credit_scoring_consent_at" timestamp with time zone,
	"marketing_consent_at" timestamp with time zone,
	"phone_first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "customers_email_key" UNIQUE("email"),
	CONSTRAINT "customers_phone_key" UNIQUE("phone"),
	CONSTRAINT "customers_ghana_card_number_key" UNIQUE("ghana_card_number"),
	CONSTRAINT "customers_momo_provider_check" CHECK ((momo_provider IS NULL) OR (momo_provider = ANY (ARRAY['mtn'::text, 'tgo'::text, 'vod'::text]))),
	CONSTRAINT "customers_kyc_tier_check" CHECK (kyc_tier = ANY (ARRAY[0, 1, 2]))
);
--> statement-breakpoint
CREATE TABLE "customer_employment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"employer_id" uuid NOT NULL,
	"employee_number" text,
	"salary_band" text DEFAULT 'unknown' NOT NULL,
	"employment_start_date" date,
	"payroll_deduction_consent" boolean DEFAULT false NOT NULL,
	"consent_signed_at" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_employment_customer_id_employer_id_key" UNIQUE("customer_id","employer_id"),
	CONSTRAINT "customer_employment_salary_band_check" CHECK (salary_band = ANY (ARRAY['unknown'::text, 'low'::text, 'mid'::text, 'high'::text])),
	CONSTRAINT "customer_employment_status_check" CHECK (status = ANY (ARRAY['active'::text, 'left_employer'::text, 'on_leave'::text, 'suspended'::text]))
);
--> statement-breakpoint
CREATE TABLE "employers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"sector" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"payroll_cycle" text DEFAULT 'monthly' NOT NULL,
	"partnership_start_date" date,
	"contact_email" "citext",
	"contact_phone" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employers_sector_check" CHECK ((sector IS NULL) OR (sector = ANY (ARRAY['public'::text, 'private'::text, 'ngo'::text, 'university'::text]))),
	CONSTRAINT "employers_status_check" CHECK (status = ANY (ARRAY['pending'::text, 'active'::text, 'paused'::text, 'terminated'::text])),
	CONSTRAINT "employers_payroll_cycle_check" CHECK (payroll_cycle = ANY (ARRAY['weekly'::text, 'biweekly'::text, 'monthly'::text]))
);
--> statement-breakpoint
CREATE TABLE "applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"plan_template_id" uuid NOT NULL,
	"order_reference" text NOT NULL,
	"order_amount_pesewas" bigint NOT NULL,
	"merchant_category" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decision_at" timestamp with time zone,
	"declined_reason" text,
	"counter_down_payment_pesewas" bigint,
	"counter_financed_pesewas" bigint,
	"expires_at" timestamp with time zone DEFAULT (now() + '24:00:00'::interval) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "applications_merchant_id_order_reference_key" UNIQUE("merchant_id","order_reference"),
	CONSTRAINT "applications_order_amount_pesewas_check" CHECK (order_amount_pesewas > 0),
	CONSTRAINT "applications_status_check" CHECK (status = ANY (ARRAY['pending'::text, 'approved'::text, 'declined'::text, 'counter_offered'::text, 'manual_review'::text, 'expired'::text, 'cancelled'::text])),
	CONSTRAINT "applications_counter_down_payment_pesewas_check" CHECK ((counter_down_payment_pesewas IS NULL) OR (counter_down_payment_pesewas >= 0)),
	CONSTRAINT "applications_counter_financed_pesewas_check" CHECK ((counter_financed_pesewas IS NULL) OR (counter_financed_pesewas >= 0))
);
--> statement-breakpoint
CREATE TABLE "merchants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_name" text NOT NULL,
	"legal_name" text NOT NULL,
	"tin" text,
	"registration_number" text,
	"email" "citext" NOT NULL,
	"phone" text NOT NULL,
	"paystack_recipient_code" text,
	"bank_account_number" text,
	"bank_code" text,
	"bank_account_name" text,
	"default_business_model" text DEFAULT 'bnpl' NOT NULL,
	"default_mdr_bps" integer DEFAULT 400 NOT NULL,
	"default_reserve_bps" integer DEFAULT 500 NOT NULL,
	"status" text DEFAULT 'pending_kyc' NOT NULL,
	"onboarded_at" timestamp with time zone,
	"suspended_at" timestamp with time zone,
	"suspension_reason" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "merchants_tin_key" UNIQUE("tin"),
	CONSTRAINT "merchants_registration_number_key" UNIQUE("registration_number"),
	CONSTRAINT "merchants_email_key" UNIQUE("email"),
	CONSTRAINT "merchants_default_business_model_check" CHECK (default_business_model = ANY (ARRAY['bnpl'::text, 'layaway'::text, 'hybrid'::text, 'rent_to_own'::text])),
	CONSTRAINT "merchants_default_mdr_bps_check" CHECK ((default_mdr_bps >= 0) AND (default_mdr_bps <= 2000)),
	CONSTRAINT "merchants_default_reserve_bps_check" CHECK ((default_reserve_bps >= 0) AND (default_reserve_bps <= 5000)),
	CONSTRAINT "merchants_status_check" CHECK (status = ANY (ARRAY['pending_kyc'::text, 'active'::text, 'suspended'::text, 'offboarded'::text]))
);
--> statement-breakpoint
CREATE TABLE "plan_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"business_model" text NOT NULL,
	"number_of_installments" smallint NOT NULL,
	"installment_frequency_days" smallint NOT NULL,
	"down_payment_bps" integer DEFAULT 0 NOT NULL,
	"interest_rate_bps" integer DEFAULT 0 NOT NULL,
	"service_fee_flat_pesewas" bigint DEFAULT 0 NOT NULL,
	"late_fee_pesewas" bigint DEFAULT 0 NOT NULL,
	"grace_period_days" smallint DEFAULT 3 NOT NULL,
	"min_amount_pesewas" bigint NOT NULL,
	"max_amount_pesewas" bigint NOT NULL,
	"eligible_categories" text[] DEFAULT '{""}' NOT NULL,
	"excluded_categories" text[] DEFAULT '{""}' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_templates_down_payment_bps_check" CHECK ((down_payment_bps >= 0) AND (down_payment_bps <= 10000)),
	CONSTRAINT "plan_templates_business_model_check" CHECK (business_model = ANY (ARRAY['bnpl'::text, 'layaway'::text, 'hybrid'::text, 'rent_to_own'::text])),
	CONSTRAINT "plan_templates_number_of_installments_check" CHECK ((number_of_installments >= 1) AND (number_of_installments <= 24)),
	CONSTRAINT "plan_templates_installment_frequency_days_check" CHECK (installment_frequency_days = ANY (ARRAY[7, 14, 30])),
	CONSTRAINT "plan_templates_interest_rate_bps_check" CHECK ((interest_rate_bps >= 0) AND (interest_rate_bps <= 10000)),
	CONSTRAINT "plan_templates_service_fee_flat_pesewas_check" CHECK (service_fee_flat_pesewas >= 0),
	CONSTRAINT "plan_templates_late_fee_pesewas_check" CHECK (late_fee_pesewas >= 0),
	CONSTRAINT "plan_templates_grace_period_days_check" CHECK ((grace_period_days >= 0) AND (grace_period_days <= 14)),
	CONSTRAINT "plan_templates_min_amount_pesewas_check" CHECK (min_amount_pesewas >= 0),
	CONSTRAINT "plan_templates_max_amount_pesewas_check" CHECK (max_amount_pesewas > 0),
	CONSTRAINT "plan_templates_check" CHECK (max_amount_pesewas >= min_amount_pesewas),
	CONSTRAINT "plan_templates_check1" CHECK ((effective_to IS NULL) OR (effective_to > effective_from))
);
--> statement-breakpoint
CREATE TABLE "credit_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"application_id" uuid,
	"score" integer NOT NULL,
	"risk_band" text NOT NULL,
	"outcome" text NOT NULL,
	"approved_limit_pesewas" bigint DEFAULT 0 NOT NULL,
	"ruleset_version" text NOT NULL,
	"rules_fired" jsonb NOT NULL,
	"features_snapshot" jsonb NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_profiles_outcome_check" CHECK (outcome = ANY (ARRAY['approved'::text, 'approved_tier_2'::text, 'counter_offer'::text, 'manual_review'::text, 'declined'::text])),
	CONSTRAINT "credit_profiles_score_check" CHECK ((score >= 0) AND (score <= 1000)),
	CONSTRAINT "credit_profiles_risk_band_check" CHECK (risk_band = ANY (ARRAY['prime'::text, 'near_prime'::text, 'subprime'::text, 'unscorable'::text])),
	CONSTRAINT "credit_profiles_approved_limit_pesewas_check" CHECK (approved_limit_pesewas >= 0)
);
--> statement-breakpoint
CREATE TABLE "customer_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"plan_template_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"business_model" text NOT NULL,
	"number_of_installments" smallint NOT NULL,
	"installment_frequency_days" smallint NOT NULL,
	"grace_period_days" smallint NOT NULL,
	"mdr_bps" integer NOT NULL,
	"reserve_bps" integer NOT NULL,
	"order_amount_pesewas" bigint NOT NULL,
	"down_payment_pesewas" bigint DEFAULT 0 NOT NULL,
	"financed_amount_pesewas" bigint NOT NULL,
	"total_interest_pesewas" bigint DEFAULT 0 NOT NULL,
	"total_fees_pesewas" bigint DEFAULT 0 NOT NULL,
	"total_payable_pesewas" bigint NOT NULL,
	"outstanding_pesewas" bigint NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"defaulted_at" timestamp with time zone,
	"restructured_from_plan_id" uuid,
	"product_delivered_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_plans_business_model_check" CHECK (business_model = ANY (ARRAY['bnpl'::text, 'layaway'::text, 'hybrid'::text, 'rent_to_own'::text])),
	CONSTRAINT "customer_plans_order_amount_pesewas_check" CHECK (order_amount_pesewas > 0),
	CONSTRAINT "customer_plans_down_payment_pesewas_check" CHECK (down_payment_pesewas >= 0),
	CONSTRAINT "customer_plans_financed_amount_pesewas_check" CHECK (financed_amount_pesewas >= 0),
	CONSTRAINT "customer_plans_total_interest_pesewas_check" CHECK (total_interest_pesewas >= 0),
	CONSTRAINT "customer_plans_total_fees_pesewas_check" CHECK (total_fees_pesewas >= 0),
	CONSTRAINT "customer_plans_status_check" CHECK (status = ANY (ARRAY['active'::text, 'completed'::text, 'defaulted'::text, 'cancelled'::text, 'restructured'::text])),
	CONSTRAINT "customer_plans_outstanding_pesewas_check" CHECK (outstanding_pesewas >= 0),
	CONSTRAINT "customer_plans_check" CHECK (outstanding_pesewas <= total_payable_pesewas),
	CONSTRAINT "customer_plans_check1" CHECK ((down_payment_pesewas + financed_amount_pesewas) = order_amount_pesewas)
);
--> statement-breakpoint
CREATE TABLE "installment_schedule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_plan_id" uuid NOT NULL,
	"sequence_number" smallint NOT NULL,
	"amount_due_pesewas" bigint NOT NULL,
	"amount_paid_pesewas" bigint DEFAULT 0 NOT NULL,
	"late_fee_pesewas" bigint DEFAULT 0 NOT NULL,
	"due_date" date NOT NULL,
	"grace_until_date" date NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempt_count" smallint DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_failure_reason" text,
	"next_retry_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"provider_reference" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "installment_schedule_customer_plan_id_sequence_number_key" UNIQUE("customer_plan_id","sequence_number"),
	CONSTRAINT "installment_schedule_sequence_number_check" CHECK (sequence_number >= 1),
	CONSTRAINT "installment_schedule_amount_due_pesewas_check" CHECK (amount_due_pesewas > 0),
	CONSTRAINT "installment_schedule_amount_paid_pesewas_check" CHECK (amount_paid_pesewas >= 0),
	CONSTRAINT "installment_schedule_late_fee_pesewas_check" CHECK (late_fee_pesewas >= 0),
	CONSTRAINT "installment_schedule_status_check" CHECK (status = ANY (ARRAY['pending'::text, 'due'::text, 'processing'::text, 'paid'::text, 'failed'::text, 'retry_scheduled'::text, 'overdue'::text, 'in_collections'::text, 'restructured'::text, 'defaulted'::text, 'waived'::text, 'refunded'::text])),
	CONSTRAINT "installment_schedule_attempt_count_check" CHECK (attempt_count >= 0),
	CONSTRAINT "installment_schedule_check" CHECK (amount_paid_pesewas <= (amount_due_pesewas + late_fee_pesewas)),
	CONSTRAINT "installment_schedule_check1" CHECK (grace_until_date >= due_date)
);
--> statement-breakpoint
CREATE TABLE "payment_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schedule_id" uuid NOT NULL,
	"customer_plan_id" uuid NOT NULL,
	"provider" text DEFAULT 'paystack' NOT NULL,
	"channel" text NOT NULL,
	"payment_method" text,
	"amount_pesewas" bigint NOT NULL,
	"idempotency_key" text NOT NULL,
	"provider_reference" text,
	"payment_link_url" text,
	"status" text DEFAULT 'in_flight' NOT NULL,
	"failure_reason" text,
	"raw_response" jsonb,
	"verify_poll_count" smallint DEFAULT 0 NOT NULL,
	"last_verified_at" timestamp with time zone,
	"initiated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	CONSTRAINT "payment_attempts_idempotency_key_key" UNIQUE("idempotency_key"),
	CONSTRAINT "payment_attempts_provider_check" CHECK (provider = ANY (ARRAY['paystack'::text, 'manual'::text])),
	CONSTRAINT "payment_attempts_channel_check" CHECK (channel = ANY (ARRAY['auto_debit'::text, 'payment_link'::text, 'manual_entry'::text])),
	CONSTRAINT "payment_attempts_payment_method_check" CHECK ((payment_method IS NULL) OR (payment_method = ANY (ARRAY['momo'::text, 'card'::text, 'bank_transfer'::text]))),
	CONSTRAINT "payment_attempts_amount_pesewas_check" CHECK (amount_pesewas > 0),
	CONSTRAINT "payment_attempts_status_check" CHECK (status = ANY (ARRAY['in_flight'::text, 'unknown'::text, 'succeeded'::text, 'failed'::text]))
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"signature" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"processing_error" text,
	CONSTRAINT "webhook_events_provider_provider_event_id_key" UNIQUE("provider","provider_event_id"),
	CONSTRAINT "webhook_events_provider_check" CHECK (provider = 'paystack'::text)
);
--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"amount_pesewas" bigint NOT NULL,
	"as_of_date" date NOT NULL,
	"reference" text NOT NULL,
	"paystack_transfer_code" text,
	"paystack_transfer_id" text,
	"status" text DEFAULT 'initiated' NOT NULL,
	"last_error" text,
	"initiated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	CONSTRAINT "payouts_merchant_id_as_of_date_key" UNIQUE("merchant_id","as_of_date"),
	CONSTRAINT "payouts_reference_key" UNIQUE("reference"),
	CONSTRAINT "payouts_amount_pesewas_check" CHECK (amount_pesewas > 0),
	CONSTRAINT "payouts_status_check" CHECK (status = ANY (ARRAY['initiated'::text, 'pending_confirmation'::text, 'settled'::text, 'failed'::text, 'unknown'::text, 'reversed'::text]))
);
--> statement-breakpoint
CREATE TABLE "held_reserves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"customer_plan_id" uuid NOT NULL,
	"business_model" text NOT NULL,
	"amount_pesewas" bigint NOT NULL,
	"released_amount_pesewas" bigint DEFAULT 0 NOT NULL,
	"held_at" timestamp with time zone DEFAULT now() NOT NULL,
	"plan_completed_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"last_release_at" timestamp with time zone,
	"fully_released_at" timestamp with time zone,
	"consumed_for_default_pesewas" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "held_reserves_business_model_check" CHECK (business_model = ANY (ARRAY['bnpl'::text, 'layaway'::text, 'hybrid'::text, 'rent_to_own'::text])),
	CONSTRAINT "held_reserves_amount_pesewas_check" CHECK (amount_pesewas > 0),
	CONSTRAINT "held_reserves_released_amount_pesewas_check" CHECK (released_amount_pesewas >= 0),
	CONSTRAINT "held_reserves_check" CHECK ((released_amount_pesewas + consumed_for_default_pesewas) <= amount_pesewas)
);
--> statement-breakpoint
CREATE TABLE "collections_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_plan_id" uuid NOT NULL,
	"schedule_id" uuid,
	"current_stage" text DEFAULT 'soft_reminder' NOT NULL,
	"stage_entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"assigned_agent_id" uuid,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"resolution" text,
	"amount_recovered_pesewas" bigint DEFAULT 0 NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collections_cases_current_stage_check" CHECK (current_stage = ANY (ARRAY['soft_reminder'::text, 'firm_reminder'::text, 'restriction_warning'::text, 'agent_assigned'::text, 'field_visit'::text, 'legal_threat'::text, 'write_off'::text])),
	CONSTRAINT "collections_cases_resolution_check" CHECK ((resolution IS NULL) OR (resolution = ANY (ARRAY['paid'::text, 'restructured'::text, 'defaulted'::text, 'written_off'::text, 'waived'::text])))
);
--> statement-breakpoint
CREATE TABLE "collections_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"action_type" text NOT NULL,
	"channel" text,
	"outcome" text,
	"notes" text,
	"performed_by" uuid,
	"performed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "collections_actions_action_type_check" CHECK (action_type = ANY (ARRAY['sms_sent'::text, 'email_sent'::text, 'call_made'::text, 'visit_scheduled'::text, 'visit_completed'::text, 'note_added'::text, 'stage_changed'::text]))
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipient_type" text NOT NULL,
	"recipient_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"template_id" text NOT NULL,
	"variables" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"to_address" text NOT NULL,
	"provider" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"provider_message_id" text,
	"failure_reason" text,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	CONSTRAINT "notifications_recipient_type_check" CHECK (recipient_type = ANY (ARRAY['customer'::text, 'merchant'::text, 'admin'::text])),
	CONSTRAINT "notifications_channel_check" CHECK (channel = ANY (ARRAY['sms'::text, 'email'::text, 'push'::text, 'in_app'::text])),
	CONSTRAINT "notifications_provider_check" CHECK ((provider IS NULL) OR (provider = ANY (ARRAY['hubtel'::text, 'arkesel'::text, 'sendgrid'::text, 'postmark'::text, 'fcm'::text]))),
	CONSTRAINT "notifications_status_check" CHECK (status = ANY (ARRAY['queued'::text, 'sent'::text, 'delivered'::text, 'failed'::text, 'bounced'::text]))
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"key" text PRIMARY KEY NOT NULL,
	"request_hash" text NOT NULL,
	"response_body" jsonb,
	"response_status" smallint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone DEFAULT (now() + '24:00:00'::interval) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rule_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ruleset_version" text NOT NULL,
	"rule_id" text NOT NULL,
	"category" text NOT NULL,
	"description" text NOT NULL,
	"configuration" jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "rule_definitions_ruleset_version_rule_id_key" UNIQUE("ruleset_version","rule_id"),
	CONSTRAINT "rule_definitions_category_check" CHECK (category = ANY (ARRAY['hard_gate'::text, 'score'::text, 'exposure'::text]))
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" text NOT NULL,
	"account_type" text NOT NULL,
	"account_ref" text NOT NULL,
	"direction" text NOT NULL,
	"amount_pesewas" bigint NOT NULL,
	"currency" char(3) DEFAULT 'GHS' NOT NULL,
	"description" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_direction_check" CHECK (direction = ANY (ARRAY['debit'::text, 'credit'::text])),
	CONSTRAINT "ledger_entries_account_type_check" CHECK (account_type = ANY (ARRAY['paystack_settlement'::text, 'merchant_payable'::text, 'reserve_held'::text, 'default_pool'::text, 'revenue'::text, 'receivable'::text, 'refund_payable'::text])),
	CONSTRAINT "ledger_entries_amount_pesewas_check" CHECK (amount_pesewas > 0),
	CONSTRAINT "ledger_entries_currency_check" CHECK (currency = 'GHS'::bpchar)
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"from_state" text,
	"to_state" text,
	"actor_id" text NOT NULL,
	"actor_type" text NOT NULL,
	"reason" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_events_actor_type_check" CHECK (actor_type = ANY (ARRAY['system'::text, 'worker'::text, 'admin'::text, 'customer'::text, 'webhook'::text, 'merchant'::text]))
);
--> statement-breakpoint
ALTER TABLE "customer_employment" ADD CONSTRAINT "customer_employment_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_employment" ADD CONSTRAINT "customer_employment_employer_id_fkey" FOREIGN KEY ("employer_id") REFERENCES "public"."employers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_plan_template_id_fkey" FOREIGN KEY ("plan_template_id") REFERENCES "public"."plan_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_profiles" ADD CONSTRAINT "credit_profiles_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_profiles" ADD CONSTRAINT "credit_profiles_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_plans" ADD CONSTRAINT "customer_plans_plan_template_id_fkey" FOREIGN KEY ("plan_template_id") REFERENCES "public"."plan_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_plans" ADD CONSTRAINT "customer_plans_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_plans" ADD CONSTRAINT "customer_plans_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_plans" ADD CONSTRAINT "customer_plans_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_plans" ADD CONSTRAINT "customer_plans_restructured_from_plan_id_fkey" FOREIGN KEY ("restructured_from_plan_id") REFERENCES "public"."customer_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installment_schedule" ADD CONSTRAINT "installment_schedule_customer_plan_id_fkey" FOREIGN KEY ("customer_plan_id") REFERENCES "public"."customer_plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "public"."installment_schedule"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_customer_plan_id_fkey" FOREIGN KEY ("customer_plan_id") REFERENCES "public"."customer_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "held_reserves" ADD CONSTRAINT "held_reserves_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "held_reserves" ADD CONSTRAINT "held_reserves_customer_plan_id_fkey" FOREIGN KEY ("customer_plan_id") REFERENCES "public"."customer_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collections_cases" ADD CONSTRAINT "collections_cases_customer_plan_id_fkey" FOREIGN KEY ("customer_plan_id") REFERENCES "public"."customer_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collections_cases" ADD CONSTRAINT "collections_cases_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "public"."installment_schedule"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collections_actions" ADD CONSTRAINT "collections_actions_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "public"."collections_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customers_blocklist_idx" ON "customers" USING btree ("is_on_blocklist" bool_ops) WHERE (is_on_blocklist = true);--> statement-breakpoint
CREATE INDEX "customers_kyc_tier_idx" ON "customers" USING btree ("kyc_tier" int2_ops) WHERE (deleted_at IS NULL);--> statement-breakpoint
CREATE INDEX "customers_phone_idx" ON "customers" USING btree ("phone" text_ops) WHERE (deleted_at IS NULL);--> statement-breakpoint
CREATE INDEX "customer_employment_customer_idx" ON "customer_employment" USING btree ("customer_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "customer_employment_employer_idx" ON "customer_employment" USING btree ("employer_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "applications_customer_idx" ON "applications" USING btree ("customer_id" timestamptz_ops,"created_at" uuid_ops);--> statement-breakpoint
CREATE INDEX "applications_merchant_idx" ON "applications" USING btree ("merchant_id" uuid_ops,"created_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "applications_pending_expiry_idx" ON "applications" USING btree ("expires_at" timestamptz_ops) WHERE (status = 'pending'::text);--> statement-breakpoint
CREATE INDEX "applications_status_idx" ON "applications" USING btree ("status" text_ops) WHERE (status = ANY (ARRAY['pending'::text, 'manual_review'::text]));--> statement-breakpoint
CREATE INDEX "merchants_email_idx" ON "merchants" USING btree ("email" citext_ops) WHERE (deleted_at IS NULL);--> statement-breakpoint
CREATE INDEX "merchants_status_idx" ON "merchants" USING btree ("status" text_ops) WHERE (deleted_at IS NULL);--> statement-breakpoint
CREATE INDEX "plan_templates_active_idx" ON "plan_templates" USING btree ("is_active" text_ops,"business_model" text_ops) WHERE (is_active = true);--> statement-breakpoint
CREATE INDEX "credit_profiles_application_idx" ON "credit_profiles" USING btree ("application_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "credit_profiles_customer_idx" ON "credit_profiles" USING btree ("customer_id" timestamptz_ops,"decided_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "customer_plans_active_idx" ON "customer_plans" USING btree ("status" text_ops) WHERE (status = 'active'::text);--> statement-breakpoint
CREATE INDEX "customer_plans_customer_idx" ON "customer_plans" USING btree ("customer_id" text_ops,"status" text_ops);--> statement-breakpoint
CREATE INDEX "customer_plans_merchant_idx" ON "customer_plans" USING btree ("merchant_id" text_ops,"status" uuid_ops);--> statement-breakpoint
CREATE INDEX "schedule_customer_upcoming_idx" ON "installment_schedule" USING btree ("customer_plan_id" date_ops,"due_date" uuid_ops) WHERE (status = ANY (ARRAY['pending'::text, 'due'::text]));--> statement-breakpoint
CREATE INDEX "schedule_due_pickup_idx" ON "installment_schedule" USING btree ("due_date" text_ops,"status" text_ops) WHERE (status = ANY (ARRAY['pending'::text, 'due'::text, 'retry_scheduled'::text]));--> statement-breakpoint
CREATE INDEX "schedule_overdue_idx" ON "installment_schedule" USING btree ("status" text_ops,"grace_until_date" text_ops) WHERE (status = ANY (ARRAY['overdue'::text, 'in_collections'::text]));--> statement-breakpoint
CREATE INDEX "schedule_stuck_idx" ON "installment_schedule" USING btree ("status" text_ops,"status_changed_at" timestamptz_ops) WHERE (status = 'processing'::text);--> statement-breakpoint
CREATE INDEX "payment_attempts_in_flight_idx" ON "payment_attempts" USING btree ("status" text_ops,"initiated_at" timestamptz_ops) WHERE (status = ANY (ARRAY['in_flight'::text, 'unknown'::text]));--> statement-breakpoint
CREATE INDEX "payment_attempts_provider_ref_idx" ON "payment_attempts" USING btree ("provider_reference" text_ops) WHERE (provider_reference IS NOT NULL);--> statement-breakpoint
CREATE INDEX "payment_attempts_schedule_idx" ON "payment_attempts" USING btree ("schedule_id" uuid_ops,"initiated_at" uuid_ops);--> statement-breakpoint
CREATE INDEX "webhook_events_unprocessed_idx" ON "webhook_events" USING btree ("received_at" timestamptz_ops) WHERE (processed_at IS NULL);--> statement-breakpoint
CREATE INDEX "payouts_merchant_idx" ON "payouts" USING btree ("merchant_id" uuid_ops,"initiated_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "payouts_pending_idx" ON "payouts" USING btree ("status" text_ops) WHERE (status = ANY (ARRAY['initiated'::text, 'pending_confirmation'::text, 'unknown'::text]));--> statement-breakpoint
CREATE INDEX "held_reserves_merchant_idx" ON "held_reserves" USING btree ("merchant_id" timestamptz_ops,"fully_released_at" timestamptz_ops) WHERE (fully_released_at IS NULL);--> statement-breakpoint
CREATE INDEX "held_reserves_plan_idx" ON "held_reserves" USING btree ("customer_plan_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "collections_cases_agent_idx" ON "collections_cases" USING btree ("assigned_agent_id" uuid_ops) WHERE (closed_at IS NULL);--> statement-breakpoint
CREATE INDEX "collections_cases_open_idx" ON "collections_cases" USING btree ("current_stage" text_ops,"opened_at" text_ops) WHERE (closed_at IS NULL);--> statement-breakpoint
CREATE INDEX "collections_actions_case_idx" ON "collections_actions" USING btree ("case_id" timestamptz_ops,"performed_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "notifications_pending_idx" ON "notifications" USING btree ("status" text_ops,"queued_at" timestamptz_ops) WHERE (status = 'queued'::text);--> statement-breakpoint
CREATE INDEX "notifications_recipient_idx" ON "notifications" USING btree ("recipient_type" text_ops,"recipient_id" timestamptz_ops,"queued_at" text_ops);--> statement-breakpoint
CREATE INDEX "idempotency_keys_expiry_idx" ON "idempotency_keys" USING btree ("expires_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "rule_definitions_active_idx" ON "rule_definitions" USING btree ("ruleset_version" text_ops,"is_active" text_ops) WHERE (is_active = true);--> statement-breakpoint
CREATE INDEX "ledger_account_balance_idx" ON "ledger_entries" USING btree ("account_type" text_ops,"account_ref" text_ops,"occurred_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "ledger_transaction_idx" ON "ledger_entries" USING btree ("transaction_id" text_ops);--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "audit_events" USING btree ("actor_id" text_ops,"occurred_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "audit_events_entity_idx" ON "audit_events" USING btree ("entity_type" uuid_ops,"entity_id" uuid_ops,"occurred_at" text_ops);--> statement-breakpoint
CREATE INDEX "audit_events_time_idx" ON "audit_events" USING btree ("occurred_at" timestamptz_ops);
*/