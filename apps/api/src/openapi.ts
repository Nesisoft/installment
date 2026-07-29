import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { schema } from '@installment/db';
import { drizzleSchema } from './common/drizzle-openapi';

/**
 * The OpenAPI document definition, shared by the running server (mounted at
 * `/docs`) and the `emit-openapi` tool that writes docs/api/openapi.json for
 * type generation (@installment/api-types) and partner integrators.
 */
export function openApiConfig() {
  return new DocumentBuilder()
    .setTitle('Installment Payment Engine API')
    .setDescription(
      'Reusable installment payment engine for the Ghanaian / West African market. ' +
        'Request bodies are validated with Zod inside the domain services. ' +
        'Most endpoints require a Bearer access token from POST /auth/login or the ' +
        'customer OTP flow; admin endpoints additionally require RBAC permissions.',
    )
    .setVersion('0.1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
    .addTag('auth', 'Login, customer OTP, token refresh')
    .addTag('health', 'Liveness / readiness')
    .addTag('merchants', 'Merchant lifecycle + settlement setup')
    .addTag('customers', 'Customer registration, KYC, consent')
    .addTag('employers', 'Employer partnerships + customer employment')
    .addTag('plan-templates', 'Installment plan template catalogue')
    .addTag('users', 'Staff / merchant / customer user administration')
    .addTag('scoring', 'Credit scoring: decisions, dry-runs, rule breakdown')
    .addTag('plans', 'Customer plan activation + installment schedules')
    .addTag('me', 'Customer self-service: own plans + schedules + card payments')
    .addTag('stores', 'Merchant storefronts (commerce)')
    .addTag('categories', 'Marketplace category taxonomy (commerce)')
    .addTag('products', 'Products, variants, images, inventory, plan offers (commerce)')
    .addTag('storefront', 'Public catalog reads: stores, categories, product search (commerce)')
    .addTag('webhooks', 'Provider webhooks (Paystack)')
    .build();
}

/**
 * Reusable component schemas for the domain read models, derived from the
 * Drizzle tables so they never drift from the database. Injected into the
 * document post-build (see below) so they publish even before every endpoint
 * references them; response wiring (`@ApiOkResponse`) then points here.
 */
function domainComponentSchemas(): Record<string, SchemaObject> {
  const s = schema;
  const models: Record<string, SchemaObject> = {
    // Engine
    Merchant: drizzleSchema(s.merchants),
    Customer: drizzleSchema(s.customers),
    Employer: drizzleSchema(s.employers),
    Employment: drizzleSchema(s.customer_employment),
    PlanTemplate: drizzleSchema(s.plan_templates),
    Application: drizzleSchema(s.applications),
    CustomerPlan: drizzleSchema(s.customer_plans),
    InstallmentSchedule: drizzleSchema(s.installment_schedule),
    Payout: drizzleSchema(s.payouts),
    HeldReserve: drizzleSchema(s.held_reserves),
    CollectionsCase: drizzleSchema(s.collections_cases),
    CollectionsAction: drizzleSchema(s.collections_actions),
    User: drizzleSchema(s.users, { omit: ['password_hash'] }),
    // Commerce
    Store: drizzleSchema(s.stores),
    Category: drizzleSchema(s.categories),
    Product: drizzleSchema(s.products, { omit: ['search_tsv'] }),
    ProductVariant: drizzleSchema(s.product_variants),
    ProductImage: drizzleSchema(s.product_images),
    Inventory: drizzleSchema(s.inventory),
    ProductPlanOffer: drizzleSchema(s.product_plan_offers),
    // Commerce — cart & orders (Phase 12)
    Address: drizzleSchema(s.addresses),
    Cart: drizzleSchema(s.carts),
    CartItem: drizzleSchema(s.cart_items),
    Order: drizzleSchema(s.orders),
    OrderItem: drizzleSchema(s.order_items),
  };

  // Composed view returned by ProductsService.getWithDetails.
  models.ProductDetails = {
    allOf: [
      { $ref: '#/components/schemas/Product' },
      {
        type: 'object',
        properties: {
          variants: {
            type: 'array',
            items: {
              allOf: [
                { $ref: '#/components/schemas/ProductVariant' },
                {
                  type: 'object',
                  properties: {
                    inventory: {
                      allOf: [{ $ref: '#/components/schemas/Inventory' }],
                      nullable: true,
                    },
                  },
                },
              ],
            },
          },
          images: { type: 'array', items: { $ref: '#/components/schemas/ProductImage' } },
          plan_template_ids: { type: 'array', items: { type: 'string', format: 'uuid' } },
        },
      },
    ],
  } as SchemaObject;

  // Composed view returned by CartService.getCart.
  models.CartWithItems = {
    allOf: [
      { $ref: '#/components/schemas/Cart' },
      {
        type: 'object',
        properties: {
          items: { type: 'array', items: { $ref: '#/components/schemas/CartItem' } },
          subtotal_pesewas: { type: 'integer' },
        },
      },
    ],
  } as SchemaObject;

  // Composed view returned by OrdersService (checkout / order reads).
  models.OrderWithItems = {
    allOf: [
      { $ref: '#/components/schemas/Order' },
      {
        type: 'object',
        properties: {
          items: { type: 'array', items: { $ref: '#/components/schemas/OrderItem' } },
        },
      },
    ],
  } as SchemaObject;

  return models;
}

/** Builds the OpenAPI document from the live Nest application's metadata. */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const document = SwaggerModule.createDocument(app, openApiConfig());
  document.components ??= {};
  document.components.schemas = {
    ...(document.components.schemas ?? {}),
    ...domainComponentSchemas(),
  };
  return document;
}
