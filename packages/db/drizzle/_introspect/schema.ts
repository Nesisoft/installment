import { pgTable, text, timestamp, index, foreignKey, unique, check, uuid, date, boolean, smallint, jsonb, bigint, integer, uniqueIndex, char, numeric, primaryKey } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"
import { citext } from "../../src/citext";
import { tsvector } from "../../src/tsvector";



export const schema_migrations = pgTable("schema_migrations", {
	filename: text().primaryKey().notNull(),
	applied_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const customers = pgTable("customers", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	first_name: text().notNull(),
	last_name: text().notNull(),
	email: citext("email").notNull(),
	phone: text().notNull(),
	date_of_birth: date(),
	ghana_card_number: text(),
	ghana_card_verified: boolean().default(false).notNull(),
	ghana_card_verified_at: timestamp({ withTimezone: true, mode: 'string' }),
	ghana_card_image_key: text(),
	momo_phone: text(),
	momo_provider: text(),
	kyc_tier: smallint().default(0).notNull(),
	is_on_blocklist: boolean().default(false).notNull(),
	blocklist_reason: text(),
	data_processing_consent_at: timestamp({ withTimezone: true, mode: 'string' }),
	credit_scoring_consent_at: timestamp({ withTimezone: true, mode: 'string' }),
	marketing_consent_at: timestamp({ withTimezone: true, mode: 'string' }),
	phone_first_seen_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	last_login_at: timestamp({ withTimezone: true, mode: 'string' }),
	metadata: jsonb().default({}).notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	deleted_at: timestamp({ withTimezone: true, mode: 'string' }),
	user_id: uuid(),
	ghana_card_status: text(),
	ghana_card_reviewed_by: uuid(),
	ghana_card_reviewed_at: timestamp({ withTimezone: true, mode: 'string' }),
	ghana_card_rejection_reason: text(),
}, (table) => [
	index("customers_blocklist_idx").using("btree", table.is_on_blocklist.asc().nullsLast().op("bool_ops")).where(sql`(is_on_blocklist = true)`),
	index("customers_ghana_card_status_idx").using("btree", table.ghana_card_status.asc().nullsLast().op("text_ops")).where(sql`((ghana_card_status IS NOT NULL) AND (deleted_at IS NULL))`),
	index("customers_kyc_tier_idx").using("btree", table.kyc_tier.asc().nullsLast().op("int2_ops")).where(sql`(deleted_at IS NULL)`),
	index("customers_phone_idx").using("btree", table.phone.asc().nullsLast().op("text_ops")).where(sql`(deleted_at IS NULL)`),
	foreignKey({
			columns: [table.ghana_card_reviewed_by],
			foreignColumns: [users.id],
			name: "customers_ghana_card_reviewed_by_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [users.id],
			name: "customers_user_id_fkey"
		}).onDelete("set null"),
	unique("customers_email_key").on(table.email),
	unique("customers_phone_key").on(table.phone),
	unique("customers_ghana_card_number_key").on(table.ghana_card_number),
	unique("customers_user_id_key").on(table.user_id),
	check("customers_ghana_card_status_check", sql`ghana_card_status = ANY (ARRAY['submitted'::text, 'approved'::text, 'rejected'::text])`),
	check("customers_ghana_card_status_needs_card", sql`(ghana_card_status IS NULL) OR (ghana_card_number IS NOT NULL)`),
	check("customers_ghana_card_verified_matches_status", sql`ghana_card_verified = ((ghana_card_status IS NOT NULL) AND (ghana_card_status = 'approved'::text))`),
	check("customers_kyc_tier_check", sql`kyc_tier = ANY (ARRAY[0, 1, 2])`),
	check("customers_momo_provider_check", sql`(momo_provider IS NULL) OR (momo_provider = ANY (ARRAY['mtn'::text, 'tgo'::text, 'vod'::text]))`),
]);

export const customer_employment = pgTable("customer_employment", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	customer_id: uuid().notNull(),
	employer_id: uuid().notNull(),
	employee_number: text(),
	salary_band: text().default('unknown').notNull(),
	employment_start_date: date(),
	payroll_deduction_consent: boolean().default(false).notNull(),
	consent_signed_at: timestamp({ withTimezone: true, mode: 'string' }),
	status: text().default('active').notNull(),
	verified_at: timestamp({ withTimezone: true, mode: 'string' }),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("customer_employment_customer_idx").using("btree", table.customer_id.asc().nullsLast().op("uuid_ops")),
	index("customer_employment_employer_idx").using("btree", table.employer_id.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.customer_id],
			foreignColumns: [customers.id],
			name: "customer_employment_customer_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.employer_id],
			foreignColumns: [employers.id],
			name: "customer_employment_employer_id_fkey"
		}),
	unique("customer_employment_customer_id_employer_id_key").on(table.customer_id, table.employer_id),
	check("customer_employment_salary_band_check", sql`salary_band = ANY (ARRAY['unknown'::text, 'low'::text, 'mid'::text, 'high'::text])`),
	check("customer_employment_status_check", sql`status = ANY (ARRAY['active'::text, 'left_employer'::text, 'on_leave'::text, 'suspended'::text])`),
]);

export const employers = pgTable("employers", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: text().notNull(),
	sector: text(),
	status: text().default('pending').notNull(),
	payroll_cycle: text().default('monthly').notNull(),
	partnership_start_date: date(),
	contact_email: citext("contact_email"),
	contact_phone: text(),
	metadata: jsonb().default({}).notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	check("employers_payroll_cycle_check", sql`payroll_cycle = ANY (ARRAY['weekly'::text, 'biweekly'::text, 'monthly'::text])`),
	check("employers_sector_check", sql`(sector IS NULL) OR (sector = ANY (ARRAY['public'::text, 'private'::text, 'ngo'::text, 'university'::text]))`),
	check("employers_status_check", sql`status = ANY (ARRAY['pending'::text, 'active'::text, 'paused'::text, 'terminated'::text])`),
]);

export const applications = pgTable("applications", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	customer_id: uuid().notNull(),
	merchant_id: uuid().notNull(),
	plan_template_id: uuid().notNull(),
	order_reference: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	order_amount_pesewas: bigint({ mode: "number" }).notNull(),
	merchant_category: text().notNull(),
	status: text().default('pending').notNull(),
	decision_at: timestamp({ withTimezone: true, mode: 'string' }),
	declined_reason: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	counter_down_payment_pesewas: bigint({ mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	counter_financed_pesewas: bigint({ mode: "number" }),
	expires_at: timestamp({ withTimezone: true, mode: 'string' }).default(sql`(now() + '24:00:00'::interval)`).notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("applications_customer_idx").using("btree", table.customer_id.asc().nullsLast().op("timestamptz_ops"), table.created_at.desc().nullsFirst().op("uuid_ops")),
	index("applications_merchant_idx").using("btree", table.merchant_id.asc().nullsLast().op("uuid_ops"), table.created_at.desc().nullsFirst().op("timestamptz_ops")),
	index("applications_pending_expiry_idx").using("btree", table.expires_at.asc().nullsLast().op("timestamptz_ops")).where(sql`(status = 'pending'::text)`),
	index("applications_status_idx").using("btree", table.status.asc().nullsLast().op("text_ops")).where(sql`(status = ANY (ARRAY['pending'::text, 'manual_review'::text]))`),
	foreignKey({
			columns: [table.customer_id],
			foreignColumns: [customers.id],
			name: "applications_customer_id_fkey"
		}),
	foreignKey({
			columns: [table.merchant_id],
			foreignColumns: [merchants.id],
			name: "applications_merchant_id_fkey"
		}),
	foreignKey({
			columns: [table.plan_template_id],
			foreignColumns: [plan_templates.id],
			name: "applications_plan_template_id_fkey"
		}),
	unique("applications_merchant_id_order_reference_key").on(table.merchant_id, table.order_reference),
	check("applications_counter_down_payment_pesewas_check", sql`(counter_down_payment_pesewas IS NULL) OR (counter_down_payment_pesewas >= 0)`),
	check("applications_counter_financed_pesewas_check", sql`(counter_financed_pesewas IS NULL) OR (counter_financed_pesewas >= 0)`),
	check("applications_order_amount_pesewas_check", sql`order_amount_pesewas > 0`),
	check("applications_status_check", sql`status = ANY (ARRAY['pending'::text, 'approved'::text, 'declined'::text, 'counter_offered'::text, 'manual_review'::text, 'expired'::text, 'cancelled'::text])`),
]);

export const credit_profiles = pgTable("credit_profiles", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	customer_id: uuid().notNull(),
	application_id: uuid(),
	score: integer().notNull(),
	risk_band: text().notNull(),
	outcome: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	approved_limit_pesewas: bigint({ mode: "number" }).default(0).notNull(),
	ruleset_version: text().notNull(),
	rules_fired: jsonb().notNull(),
	features_snapshot: jsonb().notNull(),
	decided_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("credit_profiles_application_idx").using("btree", table.application_id.asc().nullsLast().op("uuid_ops")),
	index("credit_profiles_customer_idx").using("btree", table.customer_id.asc().nullsLast().op("timestamptz_ops"), table.decided_at.desc().nullsFirst().op("timestamptz_ops")),
	foreignKey({
			columns: [table.application_id],
			foreignColumns: [applications.id],
			name: "credit_profiles_application_id_fkey"
		}),
	foreignKey({
			columns: [table.customer_id],
			foreignColumns: [customers.id],
			name: "credit_profiles_customer_id_fkey"
		}),
	check("credit_profiles_approved_limit_pesewas_check", sql`approved_limit_pesewas >= 0`),
	check("credit_profiles_outcome_check", sql`outcome = ANY (ARRAY['approved'::text, 'approved_tier_2'::text, 'counter_offer'::text, 'manual_review'::text, 'declined'::text])`),
	check("credit_profiles_risk_band_check", sql`risk_band = ANY (ARRAY['prime'::text, 'near_prime'::text, 'subprime'::text, 'unscorable'::text])`),
	check("credit_profiles_score_check", sql`(score >= 0) AND (score <= 1000)`),
]);

export const customer_plans = pgTable("customer_plans", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	customer_id: uuid().notNull(),
	merchant_id: uuid().notNull(),
	plan_template_id: uuid().notNull(),
	application_id: uuid().notNull(),
	business_model: text().notNull(),
	number_of_installments: smallint().notNull(),
	installment_frequency_days: smallint().notNull(),
	grace_period_days: smallint().notNull(),
	mdr_bps: integer().notNull(),
	reserve_bps: integer().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	order_amount_pesewas: bigint({ mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	down_payment_pesewas: bigint({ mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	financed_amount_pesewas: bigint({ mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	total_interest_pesewas: bigint({ mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	total_fees_pesewas: bigint({ mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	total_payable_pesewas: bigint({ mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	outstanding_pesewas: bigint({ mode: "number" }).notNull(),
	status: text().default('active').notNull(),
	approved_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	activated_at: timestamp({ withTimezone: true, mode: 'string' }),
	completed_at: timestamp({ withTimezone: true, mode: 'string' }),
	defaulted_at: timestamp({ withTimezone: true, mode: 'string' }),
	restructured_from_plan_id: uuid(),
	product_delivered_at: timestamp({ withTimezone: true, mode: 'string' }),
	metadata: jsonb().default({}).notNull(),
	version: integer().default(1).notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	late_fee_bps_per_week: integer().default(0).notNull(),
	late_fee_cap_bps: integer().default(0).notNull(),
	autopay_enabled: boolean().default(true).notNull(),
}, (table) => [
	index("customer_plans_active_idx").using("btree", table.status.asc().nullsLast().op("text_ops")).where(sql`(status = 'active'::text)`),
	uniqueIndex("customer_plans_application_uq").using("btree", table.application_id.asc().nullsLast().op("uuid_ops")),
	index("customer_plans_customer_idx").using("btree", table.customer_id.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
	index("customer_plans_merchant_idx").using("btree", table.merchant_id.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.application_id],
			foreignColumns: [applications.id],
			name: "customer_plans_application_id_fkey"
		}),
	foreignKey({
			columns: [table.customer_id],
			foreignColumns: [customers.id],
			name: "customer_plans_customer_id_fkey"
		}),
	foreignKey({
			columns: [table.merchant_id],
			foreignColumns: [merchants.id],
			name: "customer_plans_merchant_id_fkey"
		}),
	foreignKey({
			columns: [table.plan_template_id],
			foreignColumns: [plan_templates.id],
			name: "customer_plans_plan_template_id_fkey"
		}),
	foreignKey({
			columns: [table.restructured_from_plan_id],
			foreignColumns: [table.id],
			name: "customer_plans_restructured_from_plan_id_fkey"
		}),
	check("customer_plans_business_model_check", sql`business_model = ANY (ARRAY['bnpl'::text, 'layaway'::text, 'hybrid'::text, 'rent_to_own'::text])`),
	check("customer_plans_check", sql`outstanding_pesewas <= total_payable_pesewas`),
	check("customer_plans_check1", sql`(down_payment_pesewas + financed_amount_pesewas) = order_amount_pesewas`),
	check("customer_plans_down_payment_pesewas_check", sql`down_payment_pesewas >= 0`),
	check("customer_plans_financed_amount_pesewas_check", sql`financed_amount_pesewas >= 0`),
	check("customer_plans_late_fee_bps_per_week_check", sql`(late_fee_bps_per_week >= 0) AND (late_fee_bps_per_week <= 10000)`),
	check("customer_plans_late_fee_cap_bps_check", sql`(late_fee_cap_bps >= 0) AND (late_fee_cap_bps <= 10000)`),
	check("customer_plans_order_amount_pesewas_check", sql`order_amount_pesewas > 0`),
	check("customer_plans_outstanding_pesewas_check", sql`outstanding_pesewas >= 0`),
	check("customer_plans_status_check", sql`status = ANY (ARRAY['active'::text, 'completed'::text, 'defaulted'::text, 'cancelled'::text, 'restructured'::text])`),
	check("customer_plans_total_fees_pesewas_check", sql`total_fees_pesewas >= 0`),
	check("customer_plans_total_interest_pesewas_check", sql`total_interest_pesewas >= 0`),
]);

export const installment_schedule = pgTable("installment_schedule", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	customer_plan_id: uuid().notNull(),
	sequence_number: smallint().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	amount_due_pesewas: bigint({ mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	amount_paid_pesewas: bigint({ mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	late_fee_pesewas: bigint({ mode: "number" }).default(0).notNull(),
	due_date: date().notNull(),
	grace_until_date: date().notNull(),
	status: text().default('pending').notNull(),
	status_changed_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	attempt_count: smallint().default(0).notNull(),
	last_attempt_at: timestamp({ withTimezone: true, mode: 'string' }),
	last_failure_reason: text(),
	next_retry_at: timestamp({ withTimezone: true, mode: 'string' }),
	paid_at: timestamp({ withTimezone: true, mode: 'string' }),
	provider_reference: text(),
	version: integer().default(1).notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	late_fee_accrued_at: timestamp({ withTimezone: true, mode: 'string' }),
}, (table) => [
	index("schedule_customer_upcoming_idx").using("btree", table.customer_plan_id.asc().nullsLast().op("date_ops"), table.due_date.asc().nullsLast().op("uuid_ops")).where(sql`(status = ANY (ARRAY['pending'::text, 'due'::text]))`),
	index("schedule_due_pickup_idx").using("btree", table.due_date.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")).where(sql`(status = ANY (ARRAY['pending'::text, 'due'::text, 'retry_scheduled'::text]))`),
	index("schedule_overdue_idx").using("btree", table.status.asc().nullsLast().op("text_ops"), table.grace_until_date.asc().nullsLast().op("text_ops")).where(sql`(status = ANY (ARRAY['overdue'::text, 'in_collections'::text]))`),
	index("schedule_stuck_idx").using("btree", table.status.asc().nullsLast().op("text_ops"), table.status_changed_at.asc().nullsLast().op("timestamptz_ops")).where(sql`(status = 'processing'::text)`),
	foreignKey({
			columns: [table.customer_plan_id],
			foreignColumns: [customer_plans.id],
			name: "installment_schedule_customer_plan_id_fkey"
		}).onDelete("restrict"),
	unique("installment_schedule_customer_plan_id_sequence_number_key").on(table.customer_plan_id, table.sequence_number),
	check("installment_schedule_amount_due_pesewas_check", sql`amount_due_pesewas > 0`),
	check("installment_schedule_amount_paid_pesewas_check", sql`amount_paid_pesewas >= 0`),
	check("installment_schedule_attempt_count_check", sql`attempt_count >= 0`),
	check("installment_schedule_check", sql`amount_paid_pesewas <= (amount_due_pesewas + late_fee_pesewas)`),
	check("installment_schedule_check1", sql`grace_until_date >= due_date`),
	check("installment_schedule_late_fee_pesewas_check", sql`late_fee_pesewas >= 0`),
	check("installment_schedule_sequence_number_check", sql`sequence_number >= 1`),
	check("installment_schedule_status_check", sql`status = ANY (ARRAY['pending'::text, 'due'::text, 'processing'::text, 'paid'::text, 'failed'::text, 'retry_scheduled'::text, 'overdue'::text, 'in_collections'::text, 'restructured'::text, 'defaulted'::text, 'waived'::text, 'refunded'::text])`),
]);

export const payment_attempts = pgTable("payment_attempts", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	schedule_id: uuid().notNull(),
	customer_plan_id: uuid().notNull(),
	provider: text().default('paystack').notNull(),
	channel: text().notNull(),
	payment_method: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	amount_pesewas: bigint({ mode: "number" }).notNull(),
	idempotency_key: text().notNull(),
	provider_reference: text(),
	payment_link_url: text(),
	status: text().default('in_flight').notNull(),
	failure_reason: text(),
	raw_response: jsonb(),
	verify_poll_count: smallint().default(0).notNull(),
	last_verified_at: timestamp({ withTimezone: true, mode: 'string' }),
	initiated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	settled_at: timestamp({ withTimezone: true, mode: 'string' }),
	failed_at: timestamp({ withTimezone: true, mode: 'string' }),
}, (table) => [
	index("payment_attempts_in_flight_idx").using("btree", table.status.asc().nullsLast().op("text_ops"), table.initiated_at.asc().nullsLast().op("timestamptz_ops")).where(sql`(status = ANY (ARRAY['in_flight'::text, 'unknown'::text]))`),
	index("payment_attempts_provider_ref_idx").using("btree", table.provider_reference.asc().nullsLast().op("text_ops")).where(sql`(provider_reference IS NOT NULL)`),
	index("payment_attempts_schedule_idx").using("btree", table.schedule_id.asc().nullsLast().op("uuid_ops"), table.initiated_at.desc().nullsFirst().op("uuid_ops")),
	foreignKey({
			columns: [table.customer_plan_id],
			foreignColumns: [customer_plans.id],
			name: "payment_attempts_customer_plan_id_fkey"
		}),
	foreignKey({
			columns: [table.schedule_id],
			foreignColumns: [installment_schedule.id],
			name: "payment_attempts_schedule_id_fkey"
		}),
	unique("payment_attempts_idempotency_key_key").on(table.idempotency_key),
	check("payment_attempts_amount_pesewas_check", sql`amount_pesewas > 0`),
	check("payment_attempts_channel_check", sql`channel = ANY (ARRAY['auto_debit'::text, 'payment_link'::text, 'manual_entry'::text])`),
	check("payment_attempts_payment_method_check", sql`(payment_method IS NULL) OR (payment_method = ANY (ARRAY['momo'::text, 'card'::text, 'bank_transfer'::text]))`),
	check("payment_attempts_provider_check", sql`provider = ANY (ARRAY['paystack'::text, 'manual'::text])`),
	check("payment_attempts_status_check", sql`status = ANY (ARRAY['in_flight'::text, 'unknown'::text, 'succeeded'::text, 'failed'::text])`),
]);

export const webhook_events = pgTable("webhook_events", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	provider: text().notNull(),
	provider_event_id: text().notNull(),
	event_type: text().notNull(),
	payload: jsonb().notNull(),
	signature: text().notNull(),
	received_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	processed_at: timestamp({ withTimezone: true, mode: 'string' }),
	processing_error: text(),
}, (table) => [
	index("webhook_events_unprocessed_idx").using("btree", table.received_at.asc().nullsLast().op("timestamptz_ops")).where(sql`(processed_at IS NULL)`),
	unique("webhook_events_provider_provider_event_id_key").on(table.provider, table.provider_event_id),
	check("webhook_events_provider_check", sql`provider = 'paystack'::text`),
]);

export const payouts = pgTable("payouts", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	merchant_id: uuid().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	amount_pesewas: bigint({ mode: "number" }).notNull(),
	as_of_date: date().notNull(),
	reference: text().notNull(),
	paystack_transfer_code: text(),
	paystack_transfer_id: text(),
	status: text().default('initiated').notNull(),
	last_error: text(),
	initiated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	settled_at: timestamp({ withTimezone: true, mode: 'string' }),
	failed_at: timestamp({ withTimezone: true, mode: 'string' }),
}, (table) => [
	index("payouts_merchant_idx").using("btree", table.merchant_id.asc().nullsLast().op("uuid_ops"), table.initiated_at.desc().nullsFirst().op("timestamptz_ops")),
	index("payouts_pending_idx").using("btree", table.status.asc().nullsLast().op("text_ops")).where(sql`(status = ANY (ARRAY['initiated'::text, 'pending_confirmation'::text, 'unknown'::text]))`),
	foreignKey({
			columns: [table.merchant_id],
			foreignColumns: [merchants.id],
			name: "payouts_merchant_id_fkey"
		}),
	unique("payouts_merchant_id_as_of_date_key").on(table.merchant_id, table.as_of_date),
	unique("payouts_reference_key").on(table.reference),
	check("payouts_amount_pesewas_check", sql`amount_pesewas > 0`),
	check("payouts_status_check", sql`status = ANY (ARRAY['initiated'::text, 'pending_confirmation'::text, 'settled'::text, 'failed'::text, 'unknown'::text, 'reversed'::text])`),
]);

export const held_reserves = pgTable("held_reserves", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	merchant_id: uuid().notNull(),
	customer_plan_id: uuid().notNull(),
	business_model: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	amount_pesewas: bigint({ mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	released_amount_pesewas: bigint({ mode: "number" }).default(0).notNull(),
	held_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	plan_completed_at: timestamp({ withTimezone: true, mode: 'string' }),
	delivered_at: timestamp({ withTimezone: true, mode: 'string' }),
	last_release_at: timestamp({ withTimezone: true, mode: 'string' }),
	fully_released_at: timestamp({ withTimezone: true, mode: 'string' }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	consumed_for_default_pesewas: bigint({ mode: "number" }).default(0).notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	plan_defaulted_at: timestamp({ withTimezone: true, mode: 'string' }),
}, (table) => [
	index("held_reserves_merchant_idx").using("btree", table.merchant_id.asc().nullsLast().op("timestamptz_ops"), table.fully_released_at.asc().nullsLast().op("timestamptz_ops")).where(sql`(fully_released_at IS NULL)`),
	index("held_reserves_plan_idx").using("btree", table.customer_plan_id.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.customer_plan_id],
			foreignColumns: [customer_plans.id],
			name: "held_reserves_customer_plan_id_fkey"
		}),
	foreignKey({
			columns: [table.merchant_id],
			foreignColumns: [merchants.id],
			name: "held_reserves_merchant_id_fkey"
		}),
	check("held_reserves_amount_pesewas_check", sql`amount_pesewas > 0`),
	check("held_reserves_business_model_check", sql`business_model = ANY (ARRAY['bnpl'::text, 'layaway'::text, 'hybrid'::text, 'rent_to_own'::text])`),
	check("held_reserves_check", sql`(released_amount_pesewas + consumed_for_default_pesewas) <= amount_pesewas`),
	check("held_reserves_released_amount_pesewas_check", sql`released_amount_pesewas >= 0`),
]);

export const collections_cases = pgTable("collections_cases", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	customer_plan_id: uuid().notNull(),
	schedule_id: uuid(),
	current_stage: text().default('soft_reminder').notNull(),
	stage_entered_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	assigned_agent_id: uuid(),
	opened_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	closed_at: timestamp({ withTimezone: true, mode: 'string' }),
	resolution: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	amount_recovered_pesewas: bigint({ mode: "number" }).default(0).notNull(),
	notes: text(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("collections_cases_agent_idx").using("btree", table.assigned_agent_id.asc().nullsLast().op("uuid_ops")).where(sql`(closed_at IS NULL)`),
	index("collections_cases_open_idx").using("btree", table.current_stage.asc().nullsLast().op("text_ops"), table.opened_at.asc().nullsLast().op("text_ops")).where(sql`(closed_at IS NULL)`),
	foreignKey({
			columns: [table.assigned_agent_id],
			foreignColumns: [users.id],
			name: "collections_cases_assigned_agent_fk"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.customer_plan_id],
			foreignColumns: [customer_plans.id],
			name: "collections_cases_customer_plan_id_fkey"
		}),
	foreignKey({
			columns: [table.schedule_id],
			foreignColumns: [installment_schedule.id],
			name: "collections_cases_schedule_id_fkey"
		}),
	check("collections_cases_current_stage_check", sql`current_stage = ANY (ARRAY['soft_reminder'::text, 'firm_reminder'::text, 'restriction_warning'::text, 'agent_assigned'::text, 'field_visit'::text, 'legal_threat'::text, 'write_off'::text])`),
	check("collections_cases_resolution_check", sql`(resolution IS NULL) OR (resolution = ANY (ARRAY['paid'::text, 'restructured'::text, 'defaulted'::text, 'written_off'::text, 'waived'::text]))`),
]);

export const collections_actions = pgTable("collections_actions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	case_id: uuid().notNull(),
	action_type: text().notNull(),
	channel: text(),
	outcome: text(),
	notes: text(),
	performed_by: uuid(),
	performed_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	metadata: jsonb().default({}).notNull(),
}, (table) => [
	index("collections_actions_case_idx").using("btree", table.case_id.asc().nullsLast().op("timestamptz_ops"), table.performed_at.desc().nullsFirst().op("timestamptz_ops")),
	foreignKey({
			columns: [table.case_id],
			foreignColumns: [collections_cases.id],
			name: "collections_actions_case_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.performed_by],
			foreignColumns: [users.id],
			name: "collections_actions_performed_by_fk"
		}).onDelete("set null"),
	check("collections_actions_action_type_check", sql`action_type = ANY (ARRAY['sms_sent'::text, 'email_sent'::text, 'call_made'::text, 'visit_scheduled'::text, 'visit_completed'::text, 'note_added'::text, 'stage_changed'::text])`),
]);

export const ledger_entries = pgTable("ledger_entries", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	transaction_id: text().notNull(),
	account_type: text().notNull(),
	account_ref: text().notNull(),
	direction: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	amount_pesewas: bigint({ mode: "number" }).notNull(),
	currency: char({ length: 3 }).default('GHS').notNull(),
	description: text().notNull(),
	metadata: jsonb().default({}).notNull(),
	occurred_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ledger_account_balance_idx").using("btree", table.account_type.asc().nullsLast().op("text_ops"), table.account_ref.asc().nullsLast().op("text_ops"), table.occurred_at.asc().nullsLast().op("timestamptz_ops")),
	uniqueIndex("ledger_posting_identity_uq").using("btree", table.transaction_id.asc().nullsLast().op("text_ops"), table.account_type.asc().nullsLast().op("text_ops"), table.account_ref.asc().nullsLast().op("text_ops"), table.direction.asc().nullsLast().op("text_ops")),
	index("ledger_transaction_idx").using("btree", table.transaction_id.asc().nullsLast().op("text_ops")),
	check("ledger_entries_account_type_check", sql`account_type = ANY (ARRAY['paystack_settlement'::text, 'merchant_payable'::text, 'reserve_held'::text, 'default_pool'::text, 'revenue'::text, 'receivable'::text, 'refund_payable'::text, 'customer_float'::text])`),
	check("ledger_entries_amount_pesewas_check", sql`amount_pesewas > 0`),
	check("ledger_entries_currency_check", sql`currency = 'GHS'::bpchar`),
	check("ledger_entries_direction_check", sql`direction = ANY (ARRAY['debit'::text, 'credit'::text])`),
]);

export const notifications = pgTable("notifications", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	recipient_type: text().notNull(),
	recipient_id: uuid().notNull(),
	channel: text().notNull(),
	template_id: text().notNull(),
	variables: jsonb().default({}).notNull(),
	to_address: text().notNull(),
	provider: text(),
	status: text().default('queued').notNull(),
	provider_message_id: text(),
	failure_reason: text(),
	queued_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	sent_at: timestamp({ withTimezone: true, mode: 'string' }),
	delivered_at: timestamp({ withTimezone: true, mode: 'string' }),
	failed_at: timestamp({ withTimezone: true, mode: 'string' }),
}, (table) => [
	index("notifications_pending_idx").using("btree", table.status.asc().nullsLast().op("text_ops"), table.queued_at.asc().nullsLast().op("timestamptz_ops")).where(sql`(status = 'queued'::text)`),
	index("notifications_recipient_idx").using("btree", table.recipient_type.asc().nullsLast().op("text_ops"), table.recipient_id.asc().nullsLast().op("timestamptz_ops"), table.queued_at.desc().nullsFirst().op("text_ops")),
	check("notifications_channel_check", sql`channel = ANY (ARRAY['sms'::text, 'email'::text, 'push'::text, 'in_app'::text])`),
	check("notifications_provider_check", sql`(provider IS NULL) OR (provider = ANY (ARRAY['hubtel'::text, 'arkesel'::text, 'sendgrid'::text, 'postmark'::text, 'fcm'::text]))`),
	check("notifications_recipient_type_check", sql`recipient_type = ANY (ARRAY['customer'::text, 'merchant'::text, 'admin'::text])`),
	check("notifications_status_check", sql`status = ANY (ARRAY['queued'::text, 'sent'::text, 'delivered'::text, 'failed'::text, 'bounced'::text])`),
]);

export const idempotency_keys = pgTable("idempotency_keys", {
	key: text().primaryKey().notNull(),
	request_hash: text().notNull(),
	response_body: jsonb(),
	response_status: smallint(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	expires_at: timestamp({ withTimezone: true, mode: 'string' }).default(sql`(now() + '24:00:00'::interval)`).notNull(),
}, (table) => [
	index("idempotency_keys_expiry_idx").using("btree", table.expires_at.asc().nullsLast().op("timestamptz_ops")),
]);

export const audit_events = pgTable("audit_events", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	entity_type: text().notNull(),
	entity_id: uuid().notNull(),
	event_type: text().notNull(),
	from_state: text(),
	to_state: text(),
	actor_id: text().notNull(),
	actor_type: text().notNull(),
	reason: text(),
	metadata: jsonb().default({}).notNull(),
	occurred_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("audit_events_actor_idx").using("btree", table.actor_id.asc().nullsLast().op("text_ops"), table.occurred_at.desc().nullsFirst().op("timestamptz_ops")),
	index("audit_events_entity_idx").using("btree", table.entity_type.asc().nullsLast().op("uuid_ops"), table.entity_id.asc().nullsLast().op("uuid_ops"), table.occurred_at.desc().nullsFirst().op("text_ops")),
	index("audit_events_time_idx").using("btree", table.occurred_at.desc().nullsFirst().op("timestamptz_ops")),
	check("audit_events_actor_type_check", sql`actor_type = ANY (ARRAY['system'::text, 'worker'::text, 'admin'::text, 'customer'::text, 'webhook'::text, 'merchant'::text])`),
]);

export const users = pgTable("users", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	email: citext("email").notNull(),
	name: text().notNull(),
	password_hash: text(),
	phone: text(),
	user_type: text().notNull(),
	is_active: boolean().default(true).notNull(),
	last_login_at: timestamp({ withTimezone: true, mode: 'string' }),
	metadata: jsonb().default({}).notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	deleted_at: timestamp({ withTimezone: true, mode: 'string' }),
}, (table) => [
	index("users_active_idx").using("btree", table.is_active.asc().nullsLast().op("bool_ops")).where(sql`(is_active AND (deleted_at IS NULL))`),
	index("users_user_type_idx").using("btree", table.user_type.asc().nullsLast().op("text_ops")).where(sql`(deleted_at IS NULL)`),
	unique("users_email_key").on(table.email),
	unique("users_phone_key").on(table.phone),
	check("users_user_type_check", sql`user_type = ANY (ARRAY['system'::text, 'admin'::text, 'agent'::text, 'customer'::text, 'merchant'::text])`),
]);

export const roles = pgTable("roles", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: text().notNull(),
	description: text(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	unique("roles_name_key").on(table.name),
]);

export const permissions = pgTable("permissions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: text().notNull(),
	description: text(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	unique("permissions_name_key").on(table.name),
]);

export const rule_definitions = pgTable("rule_definitions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	ruleset_version: text().notNull(),
	rule_id: text().notNull(),
	category: text().notNull(),
	description: text().notNull(),
	configuration: jsonb().notNull(),
	is_active: boolean().default(true).notNull(),
	effective_from: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	effective_to: timestamp({ withTimezone: true, mode: 'string' }),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	created_by: uuid(),
}, (table) => [
	index("rule_definitions_active_idx").using("btree", table.ruleset_version.asc().nullsLast().op("text_ops"), table.is_active.asc().nullsLast().op("text_ops")).where(sql`(is_active = true)`),
	foreignKey({
			columns: [table.created_by],
			foreignColumns: [users.id],
			name: "rule_definitions_created_by_fk"
		}).onDelete("set null"),
	unique("rule_definitions_ruleset_version_rule_id_key").on(table.ruleset_version, table.rule_id),
	check("rule_definitions_category_check", sql`category = ANY (ARRAY['hard_gate'::text, 'score'::text, 'exposure'::text])`),
]);

export const products = pgTable("products", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	store_id: uuid().notNull(),
	merchant_id: uuid().notNull(),
	category_id: uuid(),
	title: text().notNull(),
	description: text(),
	status: text().default('draft').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	base_price_pesewas: bigint({ mode: "number" }).notNull(),
	currency: text().default('GHS').notNull(),
	attributes: jsonb().default({}).notNull(),
	search_tsv: tsvector("search_tsv").generatedAlwaysAs(sql`(setweight(to_tsvector('english'::regconfig, COALESCE(title, ''::text)), 'A'::"char") || setweight(to_tsvector('english'::regconfig, COALESCE(description, ''::text)), 'B'::"char"))`),
	metadata: jsonb().default({}).notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	deleted_at: timestamp({ withTimezone: true, mode: 'string' }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	compare_at_price_pesewas: bigint({ mode: "number" }),
	deal_ends_at: timestamp({ withTimezone: true, mode: 'string' }),
}, (table) => [
	index("products_active_idx").using("btree", table.status.asc().nullsLast().op("text_ops")).where(sql`(status = 'active'::text)`),
	index("products_category_idx").using("btree", table.category_id.asc().nullsLast().op("uuid_ops")),
	index("products_deal_idx").using("btree", table.deal_ends_at.asc().nullsLast().op("timestamptz_ops")).where(sql`(deal_ends_at IS NOT NULL)`),
	index("products_merchant_idx").using("btree", table.merchant_id.asc().nullsLast().op("uuid_ops")),
	index("products_search_idx").using("gin", table.search_tsv.asc().nullsLast().op("tsvector_ops")),
	index("products_store_idx").using("btree", table.store_id.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.category_id],
			foreignColumns: [categories.id],
			name: "products_category_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.merchant_id],
			foreignColumns: [merchants.id],
			name: "products_merchant_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.store_id],
			foreignColumns: [stores.id],
			name: "products_store_id_fkey"
		}).onDelete("cascade"),
	check("products_base_price_pesewas_check", sql`base_price_pesewas >= 0`),
	check("products_compare_at_above_price", sql`(compare_at_price_pesewas IS NULL) OR (compare_at_price_pesewas > base_price_pesewas)`),
	check("products_compare_at_price_pesewas_check", sql`(compare_at_price_pesewas IS NULL) OR (compare_at_price_pesewas >= 0)`),
	check("products_currency_check", sql`currency = 'GHS'::text`),
	check("products_deal_needs_compare_at", sql`(deal_ends_at IS NULL) OR (compare_at_price_pesewas IS NOT NULL)`),
	check("products_status_check", sql`status = ANY (ARRAY['draft'::text, 'active'::text, 'archived'::text])`),
]);

export const categories = pgTable("categories", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	parent_id: uuid(),
	name: text().notNull(),
	slug: text().notNull(),
	position: integer().default(0).notNull(),
	is_active: boolean().default(true).notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	image_key: text(),
	accent_hex: text(),
}, (table) => [
	index("categories_active_idx").using("btree", table.is_active.asc().nullsLast().op("bool_ops")).where(sql`(is_active = true)`),
	index("categories_parent_idx").using("btree", table.parent_id.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.parent_id],
			foreignColumns: [table.id],
			name: "categories_parent_id_fkey"
		}).onDelete("set null"),
	unique("categories_slug_key").on(table.slug),
	check("categories_accent_hex_check", sql`(accent_hex IS NULL) OR (accent_hex ~ '^#[0-9A-Fa-f]{6}$'::text)`),
	check("categories_check", sql`(parent_id IS NULL) OR (parent_id <> id)`),
	check("categories_slug_check", sql`slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'::text`),
]);

export const product_variants = pgTable("product_variants", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	product_id: uuid().notNull(),
	sku: text().notNull(),
	option_values: jsonb().default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	price_pesewas: bigint({ mode: "number" }),
	barcode: text(),
	is_active: boolean().default(true).notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	position: integer().default(0).notNull(),
}, (table) => [
	index("product_variants_product_idx").using("btree", table.product_id.asc().nullsLast().op("uuid_ops")),
	index("product_variants_product_position_idx").using("btree", table.product_id.asc().nullsLast().op("int4_ops"), table.position.asc().nullsLast().op("int4_ops")),
	foreignKey({
			columns: [table.product_id],
			foreignColumns: [products.id],
			name: "product_variants_product_id_fkey"
		}).onDelete("cascade"),
	unique("product_variants_product_id_sku_key").on(table.product_id, table.sku),
	check("product_variants_price_pesewas_check", sql`(price_pesewas IS NULL) OR (price_pesewas >= 0)`),
]);

export const product_images = pgTable("product_images", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	product_id: uuid().notNull(),
	storage_key: text().notNull(),
	alt_text: text(),
	position: integer().default(0).notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("product_images_product_idx").using("btree", table.product_id.asc().nullsLast().op("int4_ops"), table.position.asc().nullsLast().op("int4_ops")),
	foreignKey({
			columns: [table.product_id],
			foreignColumns: [products.id],
			name: "product_images_product_id_fkey"
		}).onDelete("cascade"),
]);

export const carts = pgTable("carts", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	customer_id: uuid().notNull(),
	status: text().default('active').notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("carts_one_active_idx").using("btree", table.customer_id.asc().nullsLast().op("uuid_ops")).where(sql`(status = 'active'::text)`),
	foreignKey({
			columns: [table.customer_id],
			foreignColumns: [customers.id],
			name: "carts_customer_id_fkey"
		}).onDelete("cascade"),
	check("carts_status_check", sql`status = ANY (ARRAY['active'::text, 'converted'::text, 'abandoned'::text])`),
]);

export const inventory = pgTable("inventory", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	variant_id: uuid().notNull(),
	quantity_available: integer().default(0).notNull(),
	quantity_reserved: integer().default(0).notNull(),
	restock_threshold: integer().default(0).notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.variant_id],
			foreignColumns: [product_variants.id],
			name: "inventory_variant_id_fkey"
		}).onDelete("cascade"),
	unique("inventory_variant_id_key").on(table.variant_id),
	check("inventory_quantity_available_check", sql`quantity_available >= 0`),
	check("inventory_quantity_reserved_check", sql`quantity_reserved >= 0`),
	check("inventory_restock_threshold_check", sql`restock_threshold >= 0`),
]);

export const product_plan_offers = pgTable("product_plan_offers", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	product_id: uuid().notNull(),
	plan_template_id: uuid().notNull(),
	is_active: boolean().default(true).notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("product_plan_offers_template_idx").using("btree", table.plan_template_id.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.plan_template_id],
			foreignColumns: [plan_templates.id],
			name: "product_plan_offers_plan_template_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.product_id],
			foreignColumns: [products.id],
			name: "product_plan_offers_product_id_fkey"
		}).onDelete("cascade"),
	unique("product_plan_offers_product_id_plan_template_id_key").on(table.product_id, table.plan_template_id),
]);

export const addresses = pgTable("addresses", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	customer_id: uuid().notNull(),
	recipient: text().notNull(),
	phone: text().notNull(),
	region: text().notNull(),
	city: text().notNull(),
	area: text(),
	landmark: text(),
	ghanapost_gps: text(),
	is_default: boolean().default(false).notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("addresses_customer_idx").using("btree", table.customer_id.asc().nullsLast().op("uuid_ops")),
	uniqueIndex("addresses_one_default_idx").using("btree", table.customer_id.asc().nullsLast().op("uuid_ops")).where(sql`is_default`),
	foreignKey({
			columns: [table.customer_id],
			foreignColumns: [customers.id],
			name: "addresses_customer_id_fkey"
		}).onDelete("cascade"),
]);

export const cart_items = pgTable("cart_items", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	cart_id: uuid().notNull(),
	variant_id: uuid().notNull(),
	merchant_id: uuid().notNull(),
	quantity: integer().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	unit_price_pesewas: bigint({ mode: "number" }).notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("cart_items_cart_idx").using("btree", table.cart_id.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.cart_id],
			foreignColumns: [carts.id],
			name: "cart_items_cart_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.merchant_id],
			foreignColumns: [merchants.id],
			name: "cart_items_merchant_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.variant_id],
			foreignColumns: [product_variants.id],
			name: "cart_items_variant_id_fkey"
		}).onDelete("cascade"),
	unique("cart_items_cart_id_variant_id_key").on(table.cart_id, table.variant_id),
	check("cart_items_quantity_check", sql`quantity > 0`),
	check("cart_items_unit_price_pesewas_check", sql`unit_price_pesewas >= 0`),
]);

export const merchants = pgTable("merchants", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	business_name: text().notNull(),
	legal_name: text().notNull(),
	tin: text(),
	registration_number: text(),
	email: citext("email").notNull(),
	phone: text().notNull(),
	paystack_recipient_code: text(),
	bank_account_number: text(),
	bank_code: text(),
	bank_account_name: text(),
	default_business_model: text().default('bnpl').notNull(),
	default_mdr_bps: integer().default(400).notNull(),
	default_reserve_bps: integer().default(500).notNull(),
	status: text().default('pending_kyc').notNull(),
	onboarded_at: timestamp({ withTimezone: true, mode: 'string' }),
	suspended_at: timestamp({ withTimezone: true, mode: 'string' }),
	suspension_reason: text(),
	metadata: jsonb().default({}).notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	deleted_at: timestamp({ withTimezone: true, mode: 'string' }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	min_payout_pesewas: bigint({ mode: "number" }).default(10000).notNull(),
	mdr_bps_override: integer(),
	reserve_bps_override: integer(),
	kyc_exempt_before: timestamp({ withTimezone: true, mode: 'string' }),
	commission_bps_override: integer(),
}, (table) => [
	index("merchants_email_idx").using("btree", table.email.asc().nullsLast().op("citext_ops")).where(sql`(deleted_at IS NULL)`),
	index("merchants_status_idx").using("btree", table.status.asc().nullsLast().op("text_ops")).where(sql`(deleted_at IS NULL)`),
	unique("merchants_tin_key").on(table.tin),
	unique("merchants_registration_number_key").on(table.registration_number),
	unique("merchants_email_key").on(table.email),
	check("merchants_commission_bps_override_check", sql`(commission_bps_override IS NULL) OR ((commission_bps_override >= 0) AND (commission_bps_override <= 2000))`),
	check("merchants_default_business_model_check", sql`default_business_model = ANY (ARRAY['bnpl'::text, 'layaway'::text, 'hybrid'::text, 'rent_to_own'::text])`),
	check("merchants_default_mdr_bps_check", sql`(default_mdr_bps >= 0) AND (default_mdr_bps <= 2000)`),
	check("merchants_default_reserve_bps_check", sql`(default_reserve_bps >= 0) AND (default_reserve_bps <= 5000)`),
	check("merchants_mdr_bps_override_check", sql`(mdr_bps_override IS NULL) OR ((mdr_bps_override >= 0) AND (mdr_bps_override <= 2000))`),
	check("merchants_min_payout_pesewas_check", sql`min_payout_pesewas >= 0`),
	check("merchants_reserve_bps_override_check", sql`(reserve_bps_override IS NULL) OR ((reserve_bps_override >= 0) AND (reserve_bps_override <= 5000))`),
	check("merchants_status_check", sql`status = ANY (ARRAY['pending_kyc'::text, 'active'::text, 'suspended'::text, 'offboarded'::text])`),
]);

export const order_items = pgTable("order_items", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	order_id: uuid().notNull(),
	variant_id: uuid(),
	product_id: uuid(),
	title: text().notNull(),
	sku: text().notNull(),
	quantity: integer().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	unit_price_pesewas: bigint({ mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	line_total_pesewas: bigint({ mode: "number" }).notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("order_items_order_idx").using("btree", table.order_id.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.order_id],
			foreignColumns: [orders.id],
			name: "order_items_order_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.product_id],
			foreignColumns: [products.id],
			name: "order_items_product_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.variant_id],
			foreignColumns: [product_variants.id],
			name: "order_items_variant_id_fkey"
		}).onDelete("set null"),
	check("order_items_line_total_pesewas_check", sql`line_total_pesewas >= 0`),
	check("order_items_quantity_check", sql`quantity > 0`),
	check("order_items_unit_price_pesewas_check", sql`unit_price_pesewas >= 0`),
]);

export const stores = pgTable("stores", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	merchant_id: uuid().notNull(),
	slug: text().notNull(),
	display_name: text().notNull(),
	about: text(),
	logo_key: text(),
	banner_key: text(),
	support_email: citext("support_email"),
	support_phone: text(),
	status: text().default('draft').notNull(),
	policies: jsonb().default({}).notNull(),
	metadata: jsonb().default({}).notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	deleted_at: timestamp({ withTimezone: true, mode: 'string' }),
	city: text(),
	region: text(),
	verified_at: timestamp({ withTimezone: true, mode: 'string' }),
	primary_category_id: uuid(),
}, (table) => [
	index("stores_primary_category_idx").using("btree", table.primary_category_id.asc().nullsLast().op("uuid_ops")).where(sql`(deleted_at IS NULL)`),
	index("stores_status_idx").using("btree", table.status.asc().nullsLast().op("text_ops")).where(sql`(status = 'active'::text)`),
	foreignKey({
			columns: [table.merchant_id],
			foreignColumns: [merchants.id],
			name: "stores_merchant_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.primary_category_id],
			foreignColumns: [categories.id],
			name: "stores_primary_category_id_fkey"
		}).onDelete("set null"),
	unique("stores_merchant_id_key").on(table.merchant_id),
	unique("stores_slug_key").on(table.slug),
	check("stores_slug_check", sql`slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'::text`),
	check("stores_status_check", sql`status = ANY (ARRAY['draft'::text, 'active'::text, 'suspended'::text])`),
]);

export const customer_card_authorizations = pgTable("customer_card_authorizations", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	customer_id: uuid().notNull(),
	authorization_code: text(),
	signature: text(),
	last4: text(),
	brand: text(),
	card_type: text(),
	bank: text(),
	exp_month: smallint(),
	exp_year: smallint(),
	reusable: boolean().default(false).notNull(),
	status: text().default('active').notNull(),
	last_used_at: timestamp({ withTimezone: true, mode: 'string' }),
	revoked_at: timestamp({ withTimezone: true, mode: 'string' }),
	revoked_reason: text(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("customer_card_authorizations_code_key").using("btree", table.authorization_code.asc().nullsLast().op("text_ops")),
	index("customer_card_authorizations_usable_idx").using("btree", table.customer_id.asc().nullsLast().op("timestamptz_ops"), table.created_at.desc().nullsFirst().op("timestamptz_ops")).where(sql`((status = 'active'::text) AND reusable)`),
	foreignKey({
			columns: [table.customer_id],
			foreignColumns: [customers.id],
			name: "customer_card_authorizations_customer_id_fkey"
		}).onDelete("cascade"),
	check("customer_card_authorizations_status_check", sql`status = ANY (ARRAY['active'::text, 'revoked'::text, 'removed'::text])`),
]);

export const refunds = pgTable("refunds", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	customer_plan_id: uuid(),
	schedule_id: uuid(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	amount_pesewas: bigint({ mode: "number" }).notNull(),
	reference: text().notNull(),
	method: text().notNull(),
	provider_transaction_reference: text(),
	paystack_refund_id: text(),
	status: text().default('initiated').notNull(),
	last_error: text(),
	requested_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	submitted_at: timestamp({ withTimezone: true, mode: 'string' }),
	succeeded_at: timestamp({ withTimezone: true, mode: 'string' }),
	failed_at: timestamp({ withTimezone: true, mode: 'string' }),
	order_return_id: uuid(),
}, (table) => [
	index("refunds_inflight_idx").using("btree", table.submitted_at.asc().nullsLast().op("timestamptz_ops")).where(sql`(status = ANY (ARRAY['pending_confirmation'::text, 'unknown'::text]))`),
	uniqueIndex("refunds_order_return_id_key").using("btree", table.order_return_id.asc().nullsLast().op("uuid_ops")),
	index("refunds_plan_idx").using("btree", table.customer_plan_id.asc().nullsLast().op("timestamptz_ops"), table.requested_at.desc().nullsFirst().op("timestamptz_ops")),
	index("refunds_unsent_idx").using("btree", table.requested_at.asc().nullsLast().op("timestamptz_ops")).where(sql`((status = 'initiated'::text) AND (method = 'paystack'::text))`),
	foreignKey({
			columns: [table.customer_plan_id],
			foreignColumns: [customer_plans.id],
			name: "refunds_customer_plan_id_fkey"
		}),
	foreignKey({
			columns: [table.order_return_id],
			foreignColumns: [order_returns.id],
			name: "refunds_order_return_id_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.schedule_id],
			foreignColumns: [installment_schedule.id],
			name: "refunds_schedule_id_fkey"
		}),
	unique("refunds_schedule_id_key").on(table.schedule_id),
	unique("refunds_reference_key").on(table.reference),
	check("refunds_amount_pesewas_check", sql`amount_pesewas > 0`),
	check("refunds_check", sql`((method = 'paystack'::text) AND (provider_transaction_reference IS NOT NULL)) OR ((method = 'manual'::text) AND (provider_transaction_reference IS NULL))`),
	check("refunds_method_check", sql`method = ANY (ARRAY['paystack'::text, 'manual'::text])`),
	check("refunds_one_owner", sql`((customer_plan_id IS NOT NULL) AND (schedule_id IS NOT NULL) AND (order_return_id IS NULL)) OR ((customer_plan_id IS NULL) AND (schedule_id IS NULL) AND (order_return_id IS NOT NULL))`),
	check("refunds_status_check", sql`status = ANY (ARRAY['initiated'::text, 'pending_confirmation'::text, 'succeeded'::text, 'failed'::text, 'unknown'::text])`),
]);

export const product_reviews = pgTable("product_reviews", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	product_id: uuid().notNull(),
	store_id: uuid().notNull(),
	customer_id: uuid().notNull(),
	order_item_id: uuid().notNull(),
	rating: smallint().notNull(),
	title: text(),
	body: text(),
	status: text().default('published').notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("product_reviews_customer_idx").using("btree", table.customer_id.asc().nullsLast().op("uuid_ops")),
	index("product_reviews_product_idx").using("btree", table.product_id.asc().nullsLast().op("uuid_ops")).where(sql`(status = 'published'::text)`),
	index("product_reviews_store_idx").using("btree", table.store_id.asc().nullsLast().op("uuid_ops")).where(sql`(status = 'published'::text)`),
	foreignKey({
			columns: [table.customer_id],
			foreignColumns: [customers.id],
			name: "product_reviews_customer_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.order_item_id],
			foreignColumns: [order_items.id],
			name: "product_reviews_order_item_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.product_id],
			foreignColumns: [products.id],
			name: "product_reviews_product_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.store_id],
			foreignColumns: [stores.id],
			name: "product_reviews_store_id_fkey"
		}).onDelete("cascade"),
	unique("product_reviews_order_item_id_key").on(table.order_item_id),
	check("product_reviews_rating_check", sql`(rating >= 1) AND (rating <= 5)`),
	check("product_reviews_status_check", sql`status = ANY (ARRAY['published'::text, 'hidden'::text])`),
]);

export const wishlist_items = pgTable("wishlist_items", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	customer_id: uuid().notNull(),
	product_id: uuid().notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("wishlist_items_customer_idx").using("btree", table.customer_id.asc().nullsLast().op("timestamptz_ops"), table.created_at.desc().nullsFirst().op("timestamptz_ops")),
	foreignKey({
			columns: [table.customer_id],
			foreignColumns: [customers.id],
			name: "wishlist_items_customer_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.product_id],
			foreignColumns: [products.id],
			name: "wishlist_items_product_id_fkey"
		}).onDelete("cascade"),
	unique("wishlist_items_customer_id_product_id_key").on(table.customer_id, table.product_id),
]);

export const orders = pgTable("orders", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	order_number: text().notNull(),
	customer_id: uuid().notNull(),
	merchant_id: uuid().notNull(),
	store_id: uuid().notNull(),
	source: text().default('internal').notNull(),
	payment_type: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	subtotal_pesewas: bigint({ mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	shipping_pesewas: bigint({ mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	discount_pesewas: bigint({ mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	total_pesewas: bigint({ mode: "number" }).notNull(),
	commission_bps: integer().default(0).notNull(),
	currency: text().default('GHS').notNull(),
	status: text().default('pending_payment').notNull(),
	shipping_address_id: uuid(),
	application_id: uuid(),
	customer_plan_id: uuid(),
	placed_at: timestamp({ withTimezone: true, mode: 'string' }),
	metadata: jsonb().default({}).notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	payment_reference: text(),
	fulfilment_method: text().default('courier').notNull(),
	pickup_hub_id: uuid(),
	return_window_days: smallint().default(7).notNull(),
	delivered_at: timestamp({ withTimezone: true, mode: 'string' }),
	return_window_ends_at: timestamp({ withTimezone: true, mode: 'string' }),
	delivery_address: jsonb(),
}, (table) => [
	index("orders_customer_idx").using("btree", table.customer_id.asc().nullsLast().op("uuid_ops")),
	index("orders_merchant_idx").using("btree", table.merchant_id.asc().nullsLast().op("uuid_ops")),
	uniqueIndex("orders_payment_reference_key").using("btree", table.payment_reference.asc().nullsLast().op("text_ops")).where(sql`(payment_reference IS NOT NULL)`),
	index("orders_status_idx").using("btree", table.status.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.application_id],
			foreignColumns: [applications.id],
			name: "orders_application_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.customer_id],
			foreignColumns: [customers.id],
			name: "orders_customer_id_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.customer_plan_id],
			foreignColumns: [customer_plans.id],
			name: "orders_customer_plan_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.merchant_id],
			foreignColumns: [merchants.id],
			name: "orders_merchant_id_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.pickup_hub_id],
			foreignColumns: [pickup_hubs.id],
			name: "orders_pickup_hub_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.shipping_address_id],
			foreignColumns: [addresses.id],
			name: "orders_shipping_address_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.store_id],
			foreignColumns: [stores.id],
			name: "orders_store_id_fkey"
		}).onDelete("restrict"),
	unique("orders_order_number_key").on(table.order_number),
	check("orders_commission_bps_check", sql`(commission_bps >= 0) AND (commission_bps <= 10000)`),
	check("orders_currency_check", sql`currency = 'GHS'::text`),
	check("orders_discount_pesewas_check", sql`discount_pesewas >= 0`),
	check("orders_fulfilment_method_check", sql`fulfilment_method = ANY (ARRAY['courier'::text, 'pickup'::text])`),
	check("orders_payment_type_check", sql`payment_type = ANY (ARRAY['full'::text, 'installment'::text])`),
	check("orders_pickup_needs_hub", sql`(fulfilment_method = 'pickup'::text) = (pickup_hub_id IS NOT NULL)`),
	check("orders_return_window_days_check", sql`return_window_days >= 0`),
	check("orders_shipping_pesewas_check", sql`shipping_pesewas >= 0`),
	check("orders_source_check", sql`source = ANY (ARRAY['internal'::text, 'partner'::text])`),
	check("orders_status_check", sql`status = ANY (ARRAY['pending_payment'::text, 'pending_approval'::text, 'paid'::text, 'financing_active'::text, 'fulfilling'::text, 'shipped'::text, 'delivered'::text, 'completed'::text, 'cancelled'::text, 'payment_failed'::text, 'declined'::text, 'returned'::text, 'defaulted'::text])`),
	check("orders_subtotal_pesewas_check", sql`subtotal_pesewas >= 0`),
	check("orders_total_pesewas_check", sql`total_pesewas >= 0`),
]);

export const search_queries = pgTable("search_queries", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	term: text().notNull(),
	normalised: text().notNull(),
	city: text(),
	customer_id: uuid(),
	result_count: integer().default(0).notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("search_queries_customer_idx").using("btree", table.customer_id.asc().nullsLast().op("timestamptz_ops"), table.created_at.desc().nullsFirst().op("uuid_ops")).where(sql`(customer_id IS NOT NULL)`),
	index("search_queries_trending_idx").using("btree", table.created_at.desc().nullsFirst().op("timestamptz_ops"), table.normalised.asc().nullsLast().op("timestamptz_ops")),
	foreignKey({
			columns: [table.customer_id],
			foreignColumns: [customers.id],
			name: "search_queries_customer_id_fkey"
		}).onDelete("set null"),
]);

export const pickup_hubs = pgTable("pickup_hubs", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: text().notNull(),
	region: text().notNull(),
	city: text().notNull(),
	area: text(),
	detail: text(),
	latitude: numeric({ precision: 9, scale:  6 }),
	longitude: numeric({ precision: 9, scale:  6 }),
	is_active: boolean().default(true).notNull(),
	position: integer().default(0).notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("pickup_hubs_city_idx").using("btree", table.city.asc().nullsLast().op("int4_ops"), table.position.asc().nullsLast().op("int4_ops")).where(sql`is_active`),
]);

export const order_events = pgTable("order_events", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	order_id: uuid().notNull(),
	event_type: text().notNull(),
	status: text(),
	label: text().notNull(),
	detail: text(),
	occurred_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("order_events_order_idx").using("btree", table.order_id.asc().nullsLast().op("timestamptz_ops"), table.occurred_at.asc().nullsLast().op("timestamptz_ops")),
	foreignKey({
			columns: [table.order_id],
			foreignColumns: [orders.id],
			name: "order_events_order_id_fkey"
		}).onDelete("cascade"),
]);

export const shipments = pgTable("shipments", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	order_id: uuid().notNull(),
	courier_name: text(),
	courier_phone: text(),
	rider_name: text(),
	tracking_code: text(),
	status: text().default('pending').notNull(),
	eta_at: timestamp({ withTimezone: true, mode: 'string' }),
	shipped_at: timestamp({ withTimezone: true, mode: 'string' }),
	delivered_at: timestamp({ withTimezone: true, mode: 'string' }),
	metadata: jsonb().default({}).notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("shipments_status_idx").using("btree", table.status.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.order_id],
			foreignColumns: [orders.id],
			name: "shipments_order_id_fkey"
		}).onDelete("cascade"),
	unique("shipments_order_id_key").on(table.order_id),
	check("shipments_status_check", sql`status = ANY (ARRAY['pending'::text, 'dispatched'::text, 'in_transit'::text, 'out_for_delivery'::text, 'delivered'::text, 'failed'::text, 'returned'::text])`),
]);

export const plan_templates = pgTable("plan_templates", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: text().notNull(),
	description: text(),
	business_model: text().notNull(),
	number_of_installments: smallint().notNull(),
	installment_frequency_days: smallint().notNull(),
	down_payment_bps: integer().default(0).notNull(),
	interest_rate_bps: integer().default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	service_fee_flat_pesewas: bigint({ mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	late_fee_pesewas: bigint({ mode: "number" }).default(0).notNull(),
	grace_period_days: smallint().default(3).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	min_amount_pesewas: bigint({ mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	max_amount_pesewas: bigint({ mode: "number" }).notNull(),
	eligible_categories: text().array().default([""]).notNull(),
	excluded_categories: text().array().default([""]).notNull(),
	is_active: boolean().default(true).notNull(),
	effective_from: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	effective_to: timestamp({ withTimezone: true, mode: 'string' }),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	late_fee_bps_per_week: integer().default(0).notNull(),
	late_fee_cap_bps: integer().default(0).notNull(),
}, (table) => [
	index("plan_templates_active_idx").using("btree", table.is_active.asc().nullsLast().op("text_ops"), table.business_model.asc().nullsLast().op("text_ops")).where(sql`(is_active = true)`),
	check("plan_templates_business_model_check", sql`business_model = ANY (ARRAY['bnpl'::text, 'layaway'::text, 'hybrid'::text, 'rent_to_own'::text])`),
	check("plan_templates_check", sql`max_amount_pesewas >= min_amount_pesewas`),
	check("plan_templates_check1", sql`(effective_to IS NULL) OR (effective_to > effective_from)`),
	check("plan_templates_down_payment_bps_check", sql`(down_payment_bps >= 0) AND (down_payment_bps <= 10000)`),
	check("plan_templates_grace_period_days_check", sql`(grace_period_days >= 0) AND (grace_period_days <= 14)`),
	check("plan_templates_installment_frequency_days_check", sql`installment_frequency_days = ANY (ARRAY[7, 14, 30])`),
	check("plan_templates_interest_rate_bps_check", sql`(interest_rate_bps >= 0) AND (interest_rate_bps <= 10000)`),
	check("plan_templates_late_fee_bps_per_week_check", sql`(late_fee_bps_per_week >= 0) AND (late_fee_bps_per_week <= 10000)`),
	check("plan_templates_late_fee_cap_bps_check", sql`(late_fee_cap_bps >= 0) AND (late_fee_cap_bps <= 10000)`),
	check("plan_templates_late_fee_pesewas_check", sql`late_fee_pesewas >= 0`),
	check("plan_templates_max_amount_pesewas_check", sql`max_amount_pesewas > 0`),
	check("plan_templates_min_amount_pesewas_check", sql`min_amount_pesewas >= 0`),
	check("plan_templates_number_of_installments_check", sql`(number_of_installments >= 1) AND (number_of_installments <= 24)`),
	check("plan_templates_service_fee_flat_pesewas_check", sql`service_fee_flat_pesewas >= 0`),
]);

export const customer_credit_standing = pgTable("customer_credit_standing", {
	customer_id: uuid().primaryKey().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	approved_limit_pesewas: bigint({ mode: "number" }).default(0).notNull(),
	on_time_payments: integer().default(0).notNull(),
	late_payments: integer().default(0).notNull(),
	last_decision_id: uuid(),
	limit_reviewed_at: timestamp({ withTimezone: true, mode: 'string' }),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.customer_id],
			foreignColumns: [customers.id],
			name: "customer_credit_standing_customer_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.last_decision_id],
			foreignColumns: [credit_profiles.id],
			name: "customer_credit_standing_last_decision_id_fkey"
		}).onDelete("set null"),
	check("customer_credit_standing_approved_limit_pesewas_check", sql`approved_limit_pesewas >= 0`),
	check("customer_credit_standing_late_payments_check", sql`late_payments >= 0`),
	check("customer_credit_standing_on_time_payments_check", sql`on_time_payments >= 0`),
]);

export const delivery_zones = pgTable("delivery_zones", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	region: text(),
	city: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fee_pesewas: bigint({ mode: "number" }).notNull(),
	eta_min_days: smallint().notNull(),
	eta_max_days: smallint().notNull(),
	is_active: boolean().default(true).notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("delivery_zones_place_idx").using("btree", table.region.asc().nullsLast().op("text_ops"), table.city.asc().nullsLast().op("text_ops")).where(sql`is_active`),
	check("delivery_zones_check", sql`eta_max_days >= eta_min_days`),
	check("delivery_zones_city_needs_region", sql`(city IS NULL) OR (region IS NOT NULL)`),
	check("delivery_zones_eta_min_days_check", sql`eta_min_days >= 0`),
	check("delivery_zones_fee_pesewas_check", sql`fee_pesewas >= 0`),
]);

export const merchant_kyc_documents = pgTable("merchant_kyc_documents", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	merchant_id: uuid().notNull(),
	doc_type: text().notNull(),
	storage_key: text().notNull(),
	status: text().default('submitted').notNull(),
	reviewed_by: uuid(),
	reviewed_at: timestamp({ withTimezone: true, mode: 'string' }),
	rejection_reason: text(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("merchant_kyc_current_idx").using("btree", table.merchant_id.asc().nullsLast().op("text_ops"), table.doc_type.asc().nullsLast().op("text_ops")).where(sql`(status <> 'rejected'::text)`),
	index("merchant_kyc_merchant_idx").using("btree", table.merchant_id.asc().nullsLast().op("timestamptz_ops"), table.created_at.desc().nullsFirst().op("uuid_ops")),
	index("merchant_kyc_pending_idx").using("btree", table.created_at.asc().nullsLast().op("timestamptz_ops")).where(sql`(status = 'submitted'::text)`),
	foreignKey({
			columns: [table.merchant_id],
			foreignColumns: [merchants.id],
			name: "merchant_kyc_documents_merchant_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.reviewed_by],
			foreignColumns: [users.id],
			name: "merchant_kyc_documents_reviewed_by_fkey"
		}).onDelete("set null"),
	check("merchant_kyc_documents_doc_type_check", sql`doc_type = ANY (ARRAY['ghana_card_front'::text, 'ghana_card_back'::text, 'shop_photo'::text, 'business_registration'::text])`),
	check("merchant_kyc_documents_status_check", sql`status = ANY (ARRAY['submitted'::text, 'approved'::text, 'rejected'::text])`),
	check("merchant_kyc_reviewed_together", sql`((status = 'submitted'::text) AND (reviewed_at IS NULL) AND (rejection_reason IS NULL)) OR ((status = 'approved'::text) AND (reviewed_at IS NOT NULL) AND (rejection_reason IS NULL)) OR ((status = 'rejected'::text) AND (reviewed_at IS NOT NULL) AND (rejection_reason IS NOT NULL))`),
]);

export const push_devices = pgTable("push_devices", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	customer_id: uuid(),
	expo_token: text().notNull(),
	platform: text().notNull(),
	app_version: text(),
	device_name: text(),
	is_active: boolean().default(true).notNull(),
	last_seen_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	merchant_id: uuid(),
}, (table) => [
	index("push_devices_customer_idx").using("btree", table.customer_id.asc().nullsLast().op("uuid_ops")).where(sql`is_active`),
	index("push_devices_merchant_idx").using("btree", table.merchant_id.asc().nullsLast().op("uuid_ops")).where(sql`is_active`),
	foreignKey({
			columns: [table.customer_id],
			foreignColumns: [customers.id],
			name: "push_devices_customer_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.merchant_id],
			foreignColumns: [merchants.id],
			name: "push_devices_merchant_id_fkey"
		}).onDelete("cascade"),
	unique("push_devices_expo_token_key").on(table.expo_token),
	check("push_devices_one_owner", sql`((customer_id IS NOT NULL) AND (merchant_id IS NULL)) OR ((customer_id IS NULL) AND (merchant_id IS NOT NULL))`),
	check("push_devices_platform_check", sql`platform = ANY (ARRAY['android'::text, 'ios'::text, 'web'::text])`),
]);

export const order_returns = pgTable("order_returns", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	order_id: uuid().notNull(),
	customer_id: uuid().notNull(),
	status: text().default('requested').notNull(),
	reason: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	refund_amount_pesewas: bigint({ mode: "number" }).notNull(),
	requested_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	decided_by: uuid(),
	decided_at: timestamp({ withTimezone: true, mode: 'string' }),
	decision_note: text(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("order_returns_customer_idx").using("btree", table.customer_id.asc().nullsLast().op("timestamptz_ops"), table.requested_at.desc().nullsFirst().op("timestamptz_ops")),
	uniqueIndex("order_returns_one_open_idx").using("btree", table.order_id.asc().nullsLast().op("uuid_ops")).where(sql`(status = 'requested'::text)`),
	index("order_returns_queue_idx").using("btree", table.requested_at.asc().nullsLast().op("timestamptz_ops")).where(sql`(status = 'requested'::text)`),
	foreignKey({
			columns: [table.customer_id],
			foreignColumns: [customers.id],
			name: "order_returns_customer_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.decided_by],
			foreignColumns: [users.id],
			name: "order_returns_decided_by_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.order_id],
			foreignColumns: [orders.id],
			name: "order_returns_order_id_fkey"
		}).onDelete("cascade"),
	check("order_returns_decided_together", sql`(status = ANY (ARRAY['requested'::text, 'cancelled'::text])) = (decided_at IS NULL)`),
	check("order_returns_reason_check", sql`length(btrim(reason)) > 0`),
	check("order_returns_refund_amount_pesewas_check", sql`refund_amount_pesewas > 0`),
	check("order_returns_rejection_needs_note", sql`(status <> 'rejected'::text) OR ((decision_note IS NOT NULL) AND (length(btrim(decision_note)) > 0))`),
	check("order_returns_status_check", sql`status = ANY (ARRAY['requested'::text, 'approved'::text, 'rejected'::text, 'cancelled'::text])`),
]);

export const role_permissions = pgTable("role_permissions", {
	role_id: uuid().notNull(),
	permission_id: uuid().notNull(),
	granted_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("role_permissions_permission_idx").using("btree", table.permission_id.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.permission_id],
			foreignColumns: [permissions.id],
			name: "role_permissions_permission_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.role_id],
			foreignColumns: [roles.id],
			name: "role_permissions_role_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.role_id, table.permission_id], name: "role_permissions_pkey"}),
]);

export const user_roles = pgTable("user_roles", {
	user_id: uuid().notNull(),
	role_id: uuid().notNull(),
	granted_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	granted_by: uuid(),
}, (table) => [
	index("user_roles_role_idx").using("btree", table.role_id.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.granted_by],
			foreignColumns: [users.id],
			name: "user_roles_granted_by_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.role_id],
			foreignColumns: [roles.id],
			name: "user_roles_role_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [users.id],
			name: "user_roles_user_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.user_id, table.role_id], name: "user_roles_pkey"}),
]);
