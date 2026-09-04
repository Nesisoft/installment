import { relations } from "drizzle-orm/relations";
import { users, customers, customer_employment, employers, applications, merchants, plan_templates, credit_profiles, customer_plans, installment_schedule, payment_attempts, payouts, held_reserves, collections_cases, collections_actions, rule_definitions, categories, products, stores, product_variants, product_images, carts, inventory, product_plan_offers, addresses, cart_items, orders, order_items, customer_card_authorizations, refunds, order_returns, product_reviews, wishlist_items, search_queries, pickup_hubs, order_events, shipments, customer_credit_standing, merchant_kyc_documents, push_devices, permissions, role_permissions, roles, user_roles } from "./schema";

export const customersRelations = relations(customers, ({one, many}) => ({
	user_ghana_card_reviewed_by: one(users, {
		fields: [customers.ghana_card_reviewed_by],
		references: [users.id],
		relationName: "customers_ghana_card_reviewed_by_users_id"
	}),
	user_user_id: one(users, {
		fields: [customers.user_id],
		references: [users.id],
		relationName: "customers_user_id_users_id"
	}),
	customer_employments: many(customer_employment),
	applications: many(applications),
	credit_profiles: many(credit_profiles),
	customer_plans: many(customer_plans),
	carts: many(carts),
	addresses: many(addresses),
	customer_card_authorizations: many(customer_card_authorizations),
	product_reviews: many(product_reviews),
	wishlist_items: many(wishlist_items),
	search_queries: many(search_queries),
	orders: many(orders),
	customer_credit_standings: many(customer_credit_standing),
	push_devices: many(push_devices),
	order_returns: many(order_returns),
}));

export const usersRelations = relations(users, ({many}) => ({
	customers_ghana_card_reviewed_by: many(customers, {
		relationName: "customers_ghana_card_reviewed_by_users_id"
	}),
	customers_user_id: many(customers, {
		relationName: "customers_user_id_users_id"
	}),
	collections_cases: many(collections_cases),
	collections_actions: many(collections_actions),
	rule_definitions: many(rule_definitions),
	merchant_kyc_documents: many(merchant_kyc_documents),
	order_returns: many(order_returns),
	user_roles_granted_by: many(user_roles, {
		relationName: "user_roles_granted_by_users_id"
	}),
	user_roles_user_id: many(user_roles, {
		relationName: "user_roles_user_id_users_id"
	}),
}));

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
	orders: many(orders),
}));

export const merchantsRelations = relations(merchants, ({many}) => ({
	applications: many(applications),
	customer_plans: many(customer_plans),
	payouts: many(payouts),
	held_reserves: many(held_reserves),
	products: many(products),
	cart_items: many(cart_items),
	stores: many(stores),
	orders: many(orders),
	merchant_kyc_documents: many(merchant_kyc_documents),
	push_devices: many(push_devices),
}));

export const plan_templatesRelations = relations(plan_templates, ({many}) => ({
	applications: many(applications),
	customer_plans: many(customer_plans),
	product_plan_offers: many(product_plan_offers),
}));

export const credit_profilesRelations = relations(credit_profiles, ({one, many}) => ({
	application: one(applications, {
		fields: [credit_profiles.application_id],
		references: [applications.id]
	}),
	customer: one(customers, {
		fields: [credit_profiles.customer_id],
		references: [customers.id]
	}),
	customer_credit_standings: many(customer_credit_standing),
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
	refunds: many(refunds),
	orders: many(orders),
}));

export const installment_scheduleRelations = relations(installment_schedule, ({one, many}) => ({
	customer_plan: one(customer_plans, {
		fields: [installment_schedule.customer_plan_id],
		references: [customer_plans.id]
	}),
	payment_attempts: many(payment_attempts),
	collections_cases: many(collections_cases),
	refunds: many(refunds),
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

export const productsRelations = relations(products, ({one, many}) => ({
	category: one(categories, {
		fields: [products.category_id],
		references: [categories.id]
	}),
	merchant: one(merchants, {
		fields: [products.merchant_id],
		references: [merchants.id]
	}),
	store: one(stores, {
		fields: [products.store_id],
		references: [stores.id]
	}),
	product_variants: many(product_variants),
	product_images: many(product_images),
	product_plan_offers: many(product_plan_offers),
	order_items: many(order_items),
	product_reviews: many(product_reviews),
	wishlist_items: many(wishlist_items),
}));

export const categoriesRelations = relations(categories, ({one, many}) => ({
	products: many(products),
	category: one(categories, {
		fields: [categories.parent_id],
		references: [categories.id],
		relationName: "categories_parent_id_categories_id"
	}),
	categories: many(categories, {
		relationName: "categories_parent_id_categories_id"
	}),
	stores: many(stores),
}));

export const storesRelations = relations(stores, ({one, many}) => ({
	products: many(products),
	merchant: one(merchants, {
		fields: [stores.merchant_id],
		references: [merchants.id]
	}),
	category: one(categories, {
		fields: [stores.primary_category_id],
		references: [categories.id]
	}),
	product_reviews: many(product_reviews),
	orders: many(orders),
}));

export const product_variantsRelations = relations(product_variants, ({one, many}) => ({
	product: one(products, {
		fields: [product_variants.product_id],
		references: [products.id]
	}),
	inventories: many(inventory),
	cart_items: many(cart_items),
	order_items: many(order_items),
}));

export const product_imagesRelations = relations(product_images, ({one}) => ({
	product: one(products, {
		fields: [product_images.product_id],
		references: [products.id]
	}),
}));

export const cartsRelations = relations(carts, ({one, many}) => ({
	customer: one(customers, {
		fields: [carts.customer_id],
		references: [customers.id]
	}),
	cart_items: many(cart_items),
}));

export const inventoryRelations = relations(inventory, ({one}) => ({
	product_variant: one(product_variants, {
		fields: [inventory.variant_id],
		references: [product_variants.id]
	}),
}));

export const product_plan_offersRelations = relations(product_plan_offers, ({one}) => ({
	plan_template: one(plan_templates, {
		fields: [product_plan_offers.plan_template_id],
		references: [plan_templates.id]
	}),
	product: one(products, {
		fields: [product_plan_offers.product_id],
		references: [products.id]
	}),
}));

export const addressesRelations = relations(addresses, ({one, many}) => ({
	customer: one(customers, {
		fields: [addresses.customer_id],
		references: [customers.id]
	}),
	orders: many(orders),
}));

export const cart_itemsRelations = relations(cart_items, ({one}) => ({
	cart: one(carts, {
		fields: [cart_items.cart_id],
		references: [carts.id]
	}),
	merchant: one(merchants, {
		fields: [cart_items.merchant_id],
		references: [merchants.id]
	}),
	product_variant: one(product_variants, {
		fields: [cart_items.variant_id],
		references: [product_variants.id]
	}),
}));

export const order_itemsRelations = relations(order_items, ({one, many}) => ({
	order: one(orders, {
		fields: [order_items.order_id],
		references: [orders.id]
	}),
	product: one(products, {
		fields: [order_items.product_id],
		references: [products.id]
	}),
	product_variant: one(product_variants, {
		fields: [order_items.variant_id],
		references: [product_variants.id]
	}),
	product_reviews: many(product_reviews),
}));

export const ordersRelations = relations(orders, ({one, many}) => ({
	order_items: many(order_items),
	application: one(applications, {
		fields: [orders.application_id],
		references: [applications.id]
	}),
	customer: one(customers, {
		fields: [orders.customer_id],
		references: [customers.id]
	}),
	customer_plan: one(customer_plans, {
		fields: [orders.customer_plan_id],
		references: [customer_plans.id]
	}),
	merchant: one(merchants, {
		fields: [orders.merchant_id],
		references: [merchants.id]
	}),
	pickup_hub: one(pickup_hubs, {
		fields: [orders.pickup_hub_id],
		references: [pickup_hubs.id]
	}),
	address: one(addresses, {
		fields: [orders.shipping_address_id],
		references: [addresses.id]
	}),
	store: one(stores, {
		fields: [orders.store_id],
		references: [stores.id]
	}),
	order_events: many(order_events),
	shipments: many(shipments),
	order_returns: many(order_returns),
}));

export const customer_card_authorizationsRelations = relations(customer_card_authorizations, ({one}) => ({
	customer: one(customers, {
		fields: [customer_card_authorizations.customer_id],
		references: [customers.id]
	}),
}));

export const refundsRelations = relations(refunds, ({one}) => ({
	customer_plan: one(customer_plans, {
		fields: [refunds.customer_plan_id],
		references: [customer_plans.id]
	}),
	order_return: one(order_returns, {
		fields: [refunds.order_return_id],
		references: [order_returns.id]
	}),
	installment_schedule: one(installment_schedule, {
		fields: [refunds.schedule_id],
		references: [installment_schedule.id]
	}),
}));

export const order_returnsRelations = relations(order_returns, ({one, many}) => ({
	refunds: many(refunds),
	customer: one(customers, {
		fields: [order_returns.customer_id],
		references: [customers.id]
	}),
	user: one(users, {
		fields: [order_returns.decided_by],
		references: [users.id]
	}),
	order: one(orders, {
		fields: [order_returns.order_id],
		references: [orders.id]
	}),
}));

export const product_reviewsRelations = relations(product_reviews, ({one}) => ({
	customer: one(customers, {
		fields: [product_reviews.customer_id],
		references: [customers.id]
	}),
	order_item: one(order_items, {
		fields: [product_reviews.order_item_id],
		references: [order_items.id]
	}),
	product: one(products, {
		fields: [product_reviews.product_id],
		references: [products.id]
	}),
	store: one(stores, {
		fields: [product_reviews.store_id],
		references: [stores.id]
	}),
}));

export const wishlist_itemsRelations = relations(wishlist_items, ({one}) => ({
	customer: one(customers, {
		fields: [wishlist_items.customer_id],
		references: [customers.id]
	}),
	product: one(products, {
		fields: [wishlist_items.product_id],
		references: [products.id]
	}),
}));

export const search_queriesRelations = relations(search_queries, ({one}) => ({
	customer: one(customers, {
		fields: [search_queries.customer_id],
		references: [customers.id]
	}),
}));

export const pickup_hubsRelations = relations(pickup_hubs, ({many}) => ({
	orders: many(orders),
}));

export const order_eventsRelations = relations(order_events, ({one}) => ({
	order: one(orders, {
		fields: [order_events.order_id],
		references: [orders.id]
	}),
}));

export const shipmentsRelations = relations(shipments, ({one}) => ({
	order: one(orders, {
		fields: [shipments.order_id],
		references: [orders.id]
	}),
}));

export const customer_credit_standingRelations = relations(customer_credit_standing, ({one}) => ({
	customer: one(customers, {
		fields: [customer_credit_standing.customer_id],
		references: [customers.id]
	}),
	credit_profile: one(credit_profiles, {
		fields: [customer_credit_standing.last_decision_id],
		references: [credit_profiles.id]
	}),
}));

export const merchant_kyc_documentsRelations = relations(merchant_kyc_documents, ({one}) => ({
	merchant: one(merchants, {
		fields: [merchant_kyc_documents.merchant_id],
		references: [merchants.id]
	}),
	user: one(users, {
		fields: [merchant_kyc_documents.reviewed_by],
		references: [users.id]
	}),
}));

export const push_devicesRelations = relations(push_devices, ({one}) => ({
	customer: one(customers, {
		fields: [push_devices.customer_id],
		references: [customers.id]
	}),
	merchant: one(merchants, {
		fields: [push_devices.merchant_id],
		references: [merchants.id]
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