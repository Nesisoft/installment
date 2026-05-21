import { relations } from "drizzle-orm/relations";
import { customers, customer_employment, employers, applications, merchants, plan_templates, credit_profiles, customer_plans, installment_schedule, payment_attempts, payouts, held_reserves, users, collections_cases, collections_actions, rule_definitions, permissions, role_permissions, roles, user_roles } from "./schema";

export const customer_employmentRelations = relations(customer_employment, ({one}) => ({
	customer: one(customers, {
		fields: [customer_employment.customer_id],
		references: [customers.id]
	}),
	employer: one(employers, {
		fields: [customer_employment.employer_id],
		references: [employers.id]
	}),
}));

export const customersRelations = relations(customers, ({many}) => ({
	customer_employments: many(customer_employment),
	applications: many(applications),
	credit_profiles: many(credit_profiles),
	customer_plans: many(customer_plans),
}));

export const employersRelations = relations(employers, ({many}) => ({
	customer_employments: many(customer_employment),
}));

export const applicationsRelations = relations(applications, ({one, many}) => ({
	customer: one(customers, {
		fields: [applications.customer_id],
		references: [customers.id]
	}),
	merchant: one(merchants, {
		fields: [applications.merchant_id],
		references: [merchants.id]
	}),
	plan_template: one(plan_templates, {
		fields: [applications.plan_template_id],
		references: [plan_templates.id]
	}),
	credit_profiles: many(credit_profiles),
	customer_plans: many(customer_plans),
}));

export const merchantsRelations = relations(merchants, ({many}) => ({
	applications: many(applications),
	customer_plans: many(customer_plans),
	payouts: many(payouts),
	held_reserves: many(held_reserves),
}));

export const plan_templatesRelations = relations(plan_templates, ({many}) => ({
	applications: many(applications),
	customer_plans: many(customer_plans),
}));

export const credit_profilesRelations = relations(credit_profiles, ({one}) => ({
	application: one(applications, {
		fields: [credit_profiles.application_id],
		references: [applications.id]
	}),
	customer: one(customers, {
		fields: [credit_profiles.customer_id],
		references: [customers.id]
	}),
}));

export const customer_plansRelations = relations(customer_plans, ({one, many}) => ({
	application: one(applications, {
		fields: [customer_plans.application_id],
		references: [applications.id]
	}),
	customer: one(customers, {
		fields: [customer_plans.customer_id],
		references: [customers.id]
	}),
	merchant: one(merchants, {
		fields: [customer_plans.merchant_id],
		references: [merchants.id]
	}),
	plan_template: one(plan_templates, {
		fields: [customer_plans.plan_template_id],
		references: [plan_templates.id]
	}),
	customer_plan: one(customer_plans, {
		fields: [customer_plans.restructured_from_plan_id],
		references: [customer_plans.id],
		relationName: "customer_plans_restructured_from_plan_id_customer_plans_id"
	}),
	customer_plans: many(customer_plans, {
		relationName: "customer_plans_restructured_from_plan_id_customer_plans_id"
	}),
	installment_schedules: many(installment_schedule),
	payment_attempts: many(payment_attempts),
	held_reserves: many(held_reserves),
	collections_cases: many(collections_cases),
}));

export const installment_scheduleRelations = relations(installment_schedule, ({one, many}) => ({
	customer_plan: one(customer_plans, {
		fields: [installment_schedule.customer_plan_id],
		references: [customer_plans.id]
	}),
	payment_attempts: many(payment_attempts),
	collections_cases: many(collections_cases),
}));

export const payment_attemptsRelations = relations(payment_attempts, ({one}) => ({
	customer_plan: one(customer_plans, {
		fields: [payment_attempts.customer_plan_id],
		references: [customer_plans.id]
	}),
	installment_schedule: one(installment_schedule, {
		fields: [payment_attempts.schedule_id],
		references: [installment_schedule.id]
	}),
}));

export const payoutsRelations = relations(payouts, ({one}) => ({
	merchant: one(merchants, {
		fields: [payouts.merchant_id],
		references: [merchants.id]
	}),
}));

export const held_reservesRelations = relations(held_reserves, ({one}) => ({
	customer_plan: one(customer_plans, {
		fields: [held_reserves.customer_plan_id],
		references: [customer_plans.id]
	}),
	merchant: one(merchants, {
		fields: [held_reserves.merchant_id],
		references: [merchants.id]
	}),
}));

export const collections_casesRelations = relations(collections_cases, ({one, many}) => ({
	user: one(users, {
		fields: [collections_cases.assigned_agent_id],
		references: [users.id]
	}),
	customer_plan: one(customer_plans, {
		fields: [collections_cases.customer_plan_id],
		references: [customer_plans.id]
	}),
	installment_schedule: one(installment_schedule, {
		fields: [collections_cases.schedule_id],
		references: [installment_schedule.id]
	}),
	collections_actions: many(collections_actions),
}));

export const usersRelations = relations(users, ({many}) => ({
	collections_cases: many(collections_cases),
	collections_actions: many(collections_actions),
	rule_definitions: many(rule_definitions),
	user_roles_granted_by: many(user_roles, {
		relationName: "user_roles_granted_by_users_id"
	}),
	user_roles_user_id: many(user_roles, {
		relationName: "user_roles_user_id_users_id"
	}),
}));

export const collections_actionsRelations = relations(collections_actions, ({one}) => ({
	collections_case: one(collections_cases, {
		fields: [collections_actions.case_id],
		references: [collections_cases.id]
	}),
	user: one(users, {
		fields: [collections_actions.performed_by],
		references: [users.id]
	}),
}));

export const rule_definitionsRelations = relations(rule_definitions, ({one}) => ({
	user: one(users, {
		fields: [rule_definitions.created_by],
		references: [users.id]
	}),
}));

export const role_permissionsRelations = relations(role_permissions, ({one}) => ({
	permission: one(permissions, {
		fields: [role_permissions.permission_id],
		references: [permissions.id]
	}),
	role: one(roles, {
		fields: [role_permissions.role_id],
		references: [roles.id]
	}),
}));

export const permissionsRelations = relations(permissions, ({many}) => ({
	role_permissions: many(role_permissions),
}));

export const rolesRelations = relations(roles, ({many}) => ({
	role_permissions: many(role_permissions),
	user_roles: many(user_roles),
}));

export const user_rolesRelations = relations(user_roles, ({one}) => ({
	user_granted_by: one(users, {
		fields: [user_roles.granted_by],
		references: [users.id],
		relationName: "user_roles_granted_by_users_id"
	}),
	role: one(roles, {
		fields: [user_roles.role_id],
		references: [roles.id]
	}),
	user_user_id: one(users, {
		fields: [user_roles.user_id],
		references: [users.id],
		relationName: "user_roles_user_id_users_id"
	}),
}));