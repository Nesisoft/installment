import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { buildOpenApiDocument } from './openapi';

function setupOpenApi(app: INestApplication): void {
  const document = buildOpenApiDocument(app);
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

  // rawBody: keep the exact bytes for Paystack webhook signature verification.
  const app = await NestFactory.create(AppModule, { bufferLogs: true, rawBody: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  setupOpenApi(app);

  // CORS: the Phase 10 React apps (customer/merchant/admin) run on their own
  // Vite origins in dev and on separate hosts in prod. Auth is Bearer-header
  // based, so credentials are not strictly required, but we allow them to keep
  // a future cookie-backed BFF viable. Drive the allowlist from CORS_ORIGINS
  // (comma-separated); use "*" to reflect any origin (dev convenience only).
  const corsOrigins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({
    origin: corsOrigins.includes('*') ? true : corsOrigins.length > 0 ? corsOrigins : false,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'],
    maxAge: 86_400,
  });

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  app.get(Logger).log(`API listening on http://0.0.0.0:${port}`, 'Bootstrap');
}

void bootstrap();
