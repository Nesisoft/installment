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
    // Commerce — the customer app (Phase 14)
    PickupHub: drizzleSchema(s.pickup_hubs),
    DeliveryZone: drizzleSchema(s.delivery_zones),
    OrderEvent: drizzleSchema(s.order_events),
    Shipment: drizzleSchema(s.shipments),
    ProductReview: drizzleSchema(s.product_reviews),
    PushDevice: drizzleSchema(s.push_devices),
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

  // A merchant with what a sale costs them (`sellerFees`): the pay-now
  // commission, and per business model the rates a plan of that model charges.
  const planFees = {
    type: 'object',
    properties: { mdr_bps: { type: 'integer' }, reserve_bps: { type: 'integer' } },
  };
  models.MerchantProfile = {
    allOf: [
      { $ref: '#/components/schemas/Merchant' },
      {
        type: 'object',
        properties: {
          fees: {
            type: 'object',
            properties: {
              pay_now_commission_bps: { type: 'integer' },
              plans: {
                type: 'object',
                properties: {
                  bnpl: planFees,
                  layaway: planFees,
                  hybrid: planFees,
                  rent_to_own: planFees,
                },
              },
              mdr_negotiated: { type: 'boolean' },
              reserve_negotiated: { type: 'boolean' },
              commission_negotiated: { type: 'boolean' },
            },
          },
        },
      },
    ],
  } as SchemaObject;

  // The merchant catalogue's own read models. They differ from the admin ones
  // by exactly one thing: keys are resolved to URLs server-side, so the portal
  // never rebuilds a bucket path and never has to change when storage does.
  models.MerchantProductImage = {
    allOf: [
      { $ref: '#/components/schemas/ProductImage' },
      {
        type: 'object',
        properties: { url: { type: 'string', nullable: true } },
      },
    ],
  } as SchemaObject;

  models.MerchantStore = {
    allOf: [
      { $ref: '#/components/schemas/Store' },
      {
        type: 'object',
        properties: {
          logo_url: { type: 'string', nullable: true },
          banner_url: { type: 'string', nullable: true },
        },
      },
    ],
  } as SchemaObject;

  models.MerchantProductRow = {
    allOf: [
      { $ref: '#/components/schemas/Product' },
      {
        type: 'object',
        properties: {
          primary_image_url: { type: 'string', nullable: true },
          variants: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', format: 'uuid' },
                sku: { type: 'string' },
                option_values: { type: 'object', additionalProperties: true },
                // Inline rather than the `money` helper: that is declared
                // further down this function and this block runs before it.
                price_pesewas: {
                  type: 'integer',
                  description: 'Integer pesewas (GHS x 100)',
                  nullable: true,
                },
                quantity_available: { type: 'integer' },
                restock_threshold: { type: 'integer' },
              },
            },
          },
        },
      },
    ],
  } as SchemaObject;

  models.MerchantProductDetails = {
    allOf: [
      { $ref: '#/components/schemas/ProductDetails' },
      {
        type: 'object',
        properties: {
          images: { type: 'array', items: { $ref: '#/components/schemas/MerchantProductImage' } },
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

  // --- Shopper read models (Phase 14) ---------------------------------------
  // Hand-written rather than derived: these are projections assembled across
  // several tables, so no single Drizzle table describes them.

  const money = { type: 'integer', description: 'Integer pesewas (GHS x 100)' } as const;
  const nullableNumber = { type: 'number', nullable: true } as const;
  const nullableString = { type: 'string', nullable: true } as const;

  models.StorefrontProduct = {
    type: 'object',
    description: 'A product as a shopping app renders a card: image, vendor, price, offer.',
    properties: {
      id: { type: 'string', format: 'uuid' },
      store_id: { type: 'string', format: 'uuid' },
      merchant_id: { type: 'string', format: 'uuid' },
      category_id: { type: 'string', format: 'uuid', nullable: true },
      title: { type: 'string' },
      base_price_pesewas: money,
      compare_at_price_pesewas: { type: 'integer', nullable: true },
      discount_percent: { type: 'integer', nullable: true },
      deal_ends_at: { type: 'string', format: 'date-time', nullable: true },
      currency: { type: 'string' },
      primary_image_url: nullableString,
      primary_image_alt: nullableString,
      store_slug: { type: 'string' },
      store_display_name: { type: 'string' },
      store_logo_url: nullableString,
      store_verified: { type: 'boolean' },
      rating_avg: nullableNumber,
      rating_count: { type: 'integer' },
      sold_count: { type: 'integer' },
      installment_eligible: { type: 'boolean' },
      in_stock: { type: 'boolean' },
      created_at: { type: 'string', format: 'date-time' },
    },
  } as SchemaObject;

  models.PaginatedProducts = {
    type: 'object',
    properties: {
      rows: { type: 'array', items: { $ref: '#/components/schemas/StorefrontProduct' } },
      total: { type: 'integer' },
    },
  } as SchemaObject;

  models.StorefrontStore = {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      slug: { type: 'string' },
      display_name: { type: 'string' },
      about: nullableString,
      city: nullableString,
      region: nullableString,
      verified: { type: 'boolean' },
      logo_url: nullableString,
      banner_url: nullableString,
      support_phone: nullableString,
      joined_at: { type: 'string', format: 'date-time' },
      product_count: { type: 'integer' },
      rating_avg: nullableNumber,
      rating_count: { type: 'integer' },
      order_count: { type: 'integer' },
      on_time_percent: nullableNumber,
    },
  } as SchemaObject;

  models.StorefrontCategory = {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      parent_id: { type: 'string', format: 'uuid', nullable: true },
      name: { type: 'string' },
      slug: { type: 'string' },
      position: { type: 'integer' },
      image_url: nullableString,
      accent_hex: nullableString,
      product_count: { type: 'integer' },
    },
  } as SchemaObject;

  models.StorefrontProductDetails = {
    allOf: [
      { $ref: '#/components/schemas/StorefrontProduct' },
      {
        type: 'object',
        properties: {
          description: nullableString,
          attributes: { type: 'object' },
          images: { type: 'array', items: { type: 'object' } },
          variants: { type: 'array', items: { type: 'object' } },
          variant_label: nullableString,
          plan_template_ids: { type: 'array', items: { type: 'string', format: 'uuid' } },
          store: { $ref: '#/components/schemas/StorefrontStore' },
          category: { type: 'object', nullable: true },
        },
      },
    ],
  } as SchemaObject;

  models.HomeFeed = {
    type: 'object',
    properties: {
      categories: { type: 'array', items: { $ref: '#/components/schemas/StorefrontCategory' } },
      deals: { type: 'array', items: { $ref: '#/components/schemas/StorefrontProduct' } },
      deals_end_at: { type: 'string', format: 'date-time', nullable: true },
      installment_picks: {
        type: 'array',
        items: { $ref: '#/components/schemas/StorefrontProduct' },
      },
      newest: { type: 'array', items: { $ref: '#/components/schemas/StorefrontProduct' } },
    },
  } as SchemaObject;

  models.PlanQuote = {
    type: 'object',
    description: "What a plan would cost, generated by the engine's own ScheduleGenerator.",
    properties: {
      plan_template_id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      description: nullableString,
      business_model: { type: 'string' },
      number_of_installments: {
        type: 'integer',
        description: "Excludes the deposit row — the engine's own definition.",
      },
      installment_frequency_days: { type: 'integer' },
      grace_period_days: { type: 'integer' },
      down_payment_bps: { type: 'integer' },
      interest_rate_bps: { type: 'integer' },
      service_fee_flat_pesewas: money,
      late_fee_bps_per_week: { type: 'integer' },
      late_fee_cap_bps: { type: 'integer' },
      min_amount_pesewas: money,
      max_amount_pesewas: money,
      down_payment_pesewas: money,
      financed_amount_pesewas: money,
      total_interest_pesewas: money,
      total_fees_pesewas: money,
      total_payable_pesewas: money,
      per_installment_pesewas: money,
      installments: { type: 'array', items: { type: 'object' } },
      eligible: { type: 'boolean' },
      ineligible_reason: nullableString,
    },
  } as SchemaObject;

  models.DeliveryQuote = {
    type: 'object',
    properties: {
      fulfilment_method: { type: 'string', enum: ['courier'] },
      fee_pesewas: money,
      eta_min_days: { type: 'integer' },
      eta_max_days: { type: 'integer' },
      eta_earliest: { type: 'string', format: 'date' },
      eta_latest: { type: 'string', format: 'date' },
      matched: { type: 'string', enum: ['city', 'region', 'national'] },
    },
  } as SchemaObject;

  // The merchant app's order queue and order sheet.
  models.MerchantOrderRow = {
    allOf: [
      { $ref: '#/components/schemas/OrderWithItems' },
      {
        type: 'object',
        properties: {
          buyer_name: { type: 'string', nullable: true },
          buyer_phone: { type: 'string', nullable: true },
          settled_pesewas: { ...money, nullable: true },
        },
      },
    ],
  } as SchemaObject;

  models.MerchantOrderPage = {
    type: 'object',
    properties: {
      rows: { type: 'array', items: { $ref: '#/components/schemas/MerchantOrderRow' } },
      total: { type: 'integer' },
    },
  } as SchemaObject;

  models.MerchantOrderCounts = {
    type: 'object',
    properties: {
      new: { type: 'integer' },
      confirmed: { type: 'integer' },
      shipped: { type: 'integer' },
      delivered: { type: 'integer' },
      completed: { type: 'integer' },
      all: { type: 'integer' },
    },
  } as SchemaObject;

  models.MerchantOrderDetail = {
    allOf: [
      { $ref: '#/components/schemas/OrderWithItems' },
      {
        type: 'object',
        properties: {
          buyer: {
            type: 'object',
            nullable: true,
            properties: {
              id: { type: 'string', format: 'uuid' },
              name: { type: 'string' },
              phone: { type: 'string' },
            },
          },
          delivery: {
            type: 'object',
            properties: {
              method: { type: 'string', enum: ['courier', 'pickup'] },
              recipient: { type: 'string', nullable: true },
              phone: { type: 'string', nullable: true },
              region: { type: 'string', nullable: true },
              city: { type: 'string', nullable: true },
              area: { type: 'string', nullable: true },
              landmark: { type: 'string', nullable: true },
              ghanapost_gps: { type: 'string', nullable: true },
              hub_name: { type: 'string', nullable: true },
              hub_detail: { type: 'string', nullable: true },
            },
          },
          settlement: {
            type: 'object',
            properties: {
              grossPesewas: money,
              feePesewas: money,
              feeLabel: { type: 'string', enum: ['commission', 'mdr'] },
              feeBps: { type: 'integer', nullable: true },
              reservePesewas: money,
              reserveBps: { type: 'integer', nullable: true },
              netPesewas: money,
              bookedAt: { type: 'string', format: 'date-time', nullable: true },
              reserveOutstandingPesewas: money,
              reserveReleasesAt: { type: 'string', format: 'date-time', nullable: true },
            },
          },
          plan: {
            type: 'object',
            nullable: true,
            properties: {
              id: { type: 'string', format: 'uuid' },
              status: { type: 'string' },
              business_model: { type: 'string' },
              mdr_bps: { type: 'integer' },
              reserve_bps: { type: 'integer' },
              total_payable_pesewas: money,
              outstanding_pesewas: money,
              collectedPesewas: money,
              paidCount: { type: 'integer' },
              installments: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    sequence_number: { type: 'integer' },
                    due_date: { type: 'string', format: 'date' },
                    amount_due_pesewas: money,
                    amount_paid_pesewas: money,
                    status: { type: 'string' },
                    paid_at: { type: 'string', format: 'date-time', nullable: true },
                  },
                },
              },
              nextDueDate: { type: 'string', format: 'date', nullable: true },
              late: { type: 'boolean' },
            },
          },
          events: { type: 'array', items: { $ref: '#/components/schemas/OrderEvent' } },
        },
      },
    ],
  } as SchemaObject;

  models.MerchantHeldReserve = {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      customerPlanId: { type: 'string', format: 'uuid' },
      orderNumber: { type: 'string', nullable: true },
      itemSummary: { type: 'string', nullable: true },
      businessModel: { type: 'string' },
      amountPesewas: money,
      releasedPesewas: money,
      consumedForDefaultPesewas: money,
      outstandingPesewas: money,
      heldAt: { type: 'string', format: 'date-time' },
      planCompletedAt: { type: 'string', format: 'date-time', nullable: true },
      deliveredAt: { type: 'string', format: 'date-time', nullable: true },
      releasableFrom: { type: 'string', format: 'date-time', nullable: true },
      fullyReleasedAt: { type: 'string', format: 'date-time', nullable: true },
    },
  } as SchemaObject;

  const planRowProps = {
    id: { type: 'string', format: 'uuid' },
    status: { type: 'string' },
    business_model: { type: 'string' },
    orderId: { type: 'string', format: 'uuid', nullable: true },
    orderNumber: { type: 'string', nullable: true },
    itemSummary: { type: 'string', nullable: true },
    customerName: { type: 'string', nullable: true },
    orderAmountPesewas: money,
    totalPayablePesewas: money,
    collectedPesewas: money,
    paidCount: { type: 'integer' },
    installmentCount: { type: 'integer' },
    nextDueDate: { type: 'string', format: 'date', nullable: true },
    late: { type: 'boolean' },
    reserveOutstandingPesewas: money,
    createdAt: { type: 'string', format: 'date-time' },
  };

  models.MerchantPlanRow = { type: 'object', properties: planRowProps } as SchemaObject;

  models.MerchantPlanPage = {
    type: 'object',
    properties: {
      rows: { type: 'array', items: { $ref: '#/components/schemas/MerchantPlanRow' } },
      total: { type: 'integer' },
    },
  } as SchemaObject;

  const returnRowProps = {
    id: { type: 'string', format: 'uuid' },
    orderId: { type: 'string', format: 'uuid' },
    orderNumber: { type: 'string' },
    status: { type: 'string' },
    reason: { type: 'string' },
    refundPesewas: money,
    requestedAt: { type: 'string', format: 'date-time' },
    decidedAt: { type: 'string', format: 'date-time', nullable: true },
    decisionNote: { type: 'string', nullable: true },
    buyerName: { type: 'string', nullable: true },
    buyerPhone: { type: 'string', nullable: true },
    itemSummary: { type: 'string', nullable: true },
    merchantLosesPesewas: money,
    commissionReversedPesewas: money,
  };

  models.MerchantReturnRow = { type: 'object', properties: returnRowProps } as SchemaObject;

  models.MerchantReturnPage = {
    type: 'object',
    properties: {
      rows: { type: 'array', items: { $ref: '#/components/schemas/MerchantReturnRow' } },
      total: { type: 'integer' },
    },
  } as SchemaObject;

  models.MerchantReturnCounts = {
    type: 'object',
    properties: {
      requested: { type: 'integer' },
      approved: { type: 'integer' },
      rejected: { type: 'integer' },
      cancelled: { type: 'integer' },
      all: { type: 'integer' },
    },
  } as SchemaObject;

  models.MerchantReturnDetail = {
    type: 'object',
    properties: {
      ...returnRowProps,
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            quantity: { type: 'integer' },
            unitPricePesewas: money,
          },
        },
      },
      orderTotalPesewas: money,
      orderStatus: { type: 'string' },
      orderPlacedAt: { type: 'string', format: 'date-time', nullable: true },
    },
  } as SchemaObject;

  models.MerchantPlanCounts = {
    type: 'object',
    properties: {
      active: { type: 'integer' },
      late: { type: 'integer' },
      completed: { type: 'integer' },
      all: { type: 'integer' },
    },
  } as SchemaObject;

  models.MerchantPlanDetail = {
    type: 'object',
    properties: {
      ...planRowProps,
      installments: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            sequence_number: { type: 'integer' },
            due_date: { type: 'string', format: 'date' },
            amount_due_pesewas: money,
            amount_paid_pesewas: money,
            late_fee_pesewas: money,
            status: { type: 'string' },
            paid_at: { type: 'string', format: 'date-time', nullable: true },
          },
        },
      },
      settledPesewas: money,
      mdrPesewas: money,
      reserveWithheldPesewas: money,
      reserveReleasesAt: { type: 'string', format: 'date-time', nullable: true },
      mdrBps: { type: 'integer' },
      reserveBps: { type: 'integer' },
    },
  } as SchemaObject;

  models.MerchantCatalogSummary = {
    type: 'object',
    properties: {
      products: { type: 'integer' },
      liveProducts: { type: 'integer' },
      variants: { type: 'integer' },
      outOfStockVariants: { type: 'integer' },
      lowStockVariants: { type: 'integer' },
    },
  } as SchemaObject;

  models.CreditStanding = {
    type: 'object',
    properties: {
      approved_limit_pesewas: money,
      in_use_pesewas: money,
      available_pesewas: money,
      on_time_payments: { type: 'integer' },
      late_payments: { type: 'integer' },
      total_payments: { type: 'integer' },
      active_plans: { type: 'integer' },
      has_limit: { type: 'boolean' },
      last_reviewed_at: { type: 'string', format: 'date-time', nullable: true },
    },
  } as SchemaObject;

  models.CustomerProfile = {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      first_name: { type: 'string' },
      last_name: { type: 'string' },
      email: { type: 'string' },
      phone: { type: 'string' },
      momo_phone: nullableString,
      momo_provider: nullableString,
      kyc_tier: { type: 'integer' },
      ghana_card_verified: { type: 'boolean' },
      consents: { type: 'object' },
      credit: { $ref: '#/components/schemas/CreditStanding' },
      counts: { type: 'object' },
      created_at: { type: 'string', format: 'date-time' },
    },
  } as SchemaObject;

  models.FeedInstallment = {
    allOf: [
      { $ref: '#/components/schemas/InstallmentSchedule' },
      {
        type: 'object',
        description: 'An instalment carrying its plan, order and product context.',
        properties: {
          position: {
            type: 'integer',
            description: 'Position among the plan rows, deposit included.',
          },
          total_installments: { type: 'integer' },
          payable_pesewas: money,
          is_down_payment: { type: 'boolean' },
          is_overdue: { type: 'boolean' },
          plan: { type: 'object' },
          merchant_name: nullableString,
          order_id: { type: 'string', format: 'uuid', nullable: true },
          order_number: nullableString,
          item_title: nullableString,
        },
      },
    ],
  } as SchemaObject;

  models.OrderTracking = {
    type: 'object',
    properties: {
      order_id: { type: 'string', format: 'uuid' },
      order_number: { type: 'string' },
      status: { type: 'string' },
      fulfilment_method: { type: 'string', enum: ['courier', 'pickup'] },
      pickup_hub: { allOf: [{ $ref: '#/components/schemas/PickupHub' }], nullable: true },
      shipment: { allOf: [{ $ref: '#/components/schemas/Shipment' }], nullable: true },
      delivered_at: { type: 'string', format: 'date-time', nullable: true },
      return_window_ends_at: { type: 'string', format: 'date-time', nullable: true },
      events: { type: 'array', items: { type: 'object' } },
    },
  } as SchemaObject;

  models.OrderWithPlan = {
    allOf: [
      { $ref: '#/components/schemas/OrderWithItems' },
      {
        type: 'object',
        properties: {
          plan: { allOf: [{ $ref: '#/components/schemas/CustomerPlan' }], nullable: true },
          schedule: {
            type: 'array',
            items: { $ref: '#/components/schemas/InstallmentSchedule' },
          },
          pickup_hub: { allOf: [{ $ref: '#/components/schemas/PickupHub' }], nullable: true },
        },
      },
    ],
  } as SchemaObject;

  models.DecidedOrder = {
    type: 'object',
    description:
      'A checked-out order and the credit decision made on it, so the app can render approval, decline or review without a second call.',
    properties: {
      order: { $ref: '#/components/schemas/OrderWithItems' },
      outcome: {
        type: 'string',
        enum: ['paid_later', 'approved', 'declined', 'in_review', 'failed'],
      },
      application_id: { type: 'string', format: 'uuid', nullable: true },
      plan: { allOf: [{ $ref: '#/components/schemas/CustomerPlan' }], nullable: true },
      schedule: { type: 'array', items: { $ref: '#/components/schemas/InstallmentSchedule' } },
      down_payment: {
        allOf: [{ $ref: '#/components/schemas/InstallmentSchedule' }],
        nullable: true,
      },
      approved_limit_pesewas: { type: 'integer', nullable: true },
      message: nullableString,
    },
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
