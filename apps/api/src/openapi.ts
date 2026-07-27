import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';

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

/** Builds the OpenAPI document from the live Nest application's metadata. */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  return SwaggerModule.createDocument(app, openApiConfig());
}
