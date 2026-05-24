import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';

function setupOpenApi(app: INestApplication): void {
  const config = new DocumentBuilder()
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
    .addTag('me', 'Customer self-service: own plans + schedules')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document, {
    jsonDocumentUrl: 'docs-json',
    swaggerOptions: { persistAuthorization: true },
  });
}

async function bootstrap(): Promise<void> {
  const dsn = process.env.SENTRY_DSN;
  if (dsn) {
    Sentry.init({
      dsn,
      environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0),
    });
  }

  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  setupOpenApi(app);

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  app.get(Logger).log(`API listening on http://0.0.0.0:${port}`, 'Bootstrap');
}

void bootstrap();
