import {
  Controller,
  Get,
  Injectable,
  Module,
  Param,
  RequestMethod,
  UseGuards,
  type CanActivate,
  type INestApplication,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MetricsController } from './metrics.controller';
import { HttpMetricsMiddleware } from './http-metrics.middleware';
import { ledgerHealthy, ledgerUnbalancedTransactions, recordJobRun } from './metrics';

vi.mock('@sentry/node', () => ({ captureException: vi.fn() }));

const TOKEN = 'a-scrape-token-of-at-least-24-chars';

@Injectable()
class DenyAll implements CanActivate {
  canActivate(): boolean {
    return false;
  }
}

@Controller('things')
class ThingsController {
  @Get(':id')
  get(@Param('id') id: string) {
    return { id };
  }

  @Get(':id/secret')
  @UseGuards(DenyAll)
  secret() {
    return {};
  }
}

async function appWith(token: string | undefined): Promise<INestApplication> {
  @Module({
    controllers: [MetricsController, ThingsController],
    providers: [{ provide: ConfigService, useValue: { get: () => token } }],
  })
  class TestAppModule implements NestModule {
    configure(consumer: MiddlewareConsumer): void {
      consumer.apply(HttpMetricsMiddleware).forRoutes('{*splat}');
      // Mounted the way nestjs-pino mounts its request logger: on `*`, which
      // Nest rewrites to `/{*path}` and which then shows up as req.route.
      consumer
        .apply((_req: unknown, _res: unknown, next: () => void) => next())
        .forRoutes({
          path: '*',
          method: RequestMethod.ALL,
        });
    }
  }
  const moduleRef = await Test.createTestingModule({ imports: [TestAppModule] }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

describe('GET /metrics', () => {
  let app: INestApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('is not there at all without a configured token', async () => {
    app = await appWith(undefined);
    expect((await request(app.getHttpServer()).get('/metrics')).status).toBe(404);
  });

  it('refuses a missing or wrong token', async () => {
    app = await appWith(TOKEN);
    expect((await request(app.getHttpServer()).get('/metrics')).status).toBe(401);
    const wrong = await request(app.getHttpServer())
      .get('/metrics')
      .set('Authorization', `Bearer ${TOKEN.slice(0, -1)}x`);
    expect(wrong.status).toBe(401);
  });

  it('serves the registry in Prometheus text format to the right token', async () => {
    app = await appWith(TOKEN);
    recordJobRun('daily-settlement', 'success', new Date('2026-10-28T06:00:00Z'));
    recordJobRun('daily-settlement', 'failure', new Date('2026-10-29T06:00:00Z'));

    const res = await request(app.getHttpServer())
      .get('/metrics')
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.text).toContain(
      'installment_job_runs_total{job="daily-settlement",outcome="success"} 1',
    );
    expect(res.text).toContain(
      'installment_job_runs_total{job="daily-settlement",outcome="failure"} 1',
    );
    // The last run failed, so the last success is still the day before.
    expect(res.text).toContain(
      'installment_job_last_success_timestamp_seconds{job="daily-settlement"} 1793167200',
    );
    expect(res.text).toContain(
      'installment_job_last_run_timestamp_seconds{job="daily-settlement"} 1793253600',
    );
    expect(res.text).toContain('process_cpu_user_seconds_total');
  });

  it('reports no ledger health until this process has run the check', async () => {
    app = await appWith(TOKEN);
    const scrape = async () =>
      (await request(app!.getHttpServer()).get('/metrics').set('Authorization', `Bearer ${TOKEN}`))
        .text;

    // Not "0 = unbalanced" after a restart: no sample at all.
    expect(await scrape()).not.toMatch(/^installment_ledger_healthy /m);
    expect(await scrape()).not.toMatch(/^installment_ledger_unbalanced_transactions /m);

    ledgerHealthy.set(1);
    ledgerUnbalancedTransactions.set(0);
    expect(await scrape()).toMatch(/^installment_ledger_healthy 1$/m);
    expect(await scrape()).toMatch(/^installment_ledger_unbalanced_transactions 0$/m);
  });

  it('times requests by route pattern and final status, never by URL', async () => {
    app = await appWith(TOKEN);
    await request(app.getHttpServer()).get('/things/order-123');
    await request(app.getHttpServer()).get('/things/order-456');

    const res = await request(app.getHttpServer())
      .get('/metrics')
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(res.text).toMatch(
      /http_request_duration_seconds_count\{method="GET",route="\/things\/:id",status="200"\} 2/,
    );
    expect(res.text).not.toContain('order-123');
    // The scrape itself is not counted.
    expect(res.text).not.toContain('route="/metrics"');
  });

  it('counts requests a guard refused and requests that matched no route', async () => {
    app = await appWith(TOKEN);
    expect((await request(app.getHttpServer()).get('/things/1/secret')).status).toBe(403);
    expect((await request(app.getHttpServer()).get('/wp-login.php')).status).toBe(404);

    const res = await request(app.getHttpServer())
      .get('/metrics')
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(res.text).toMatch(
      /http_request_duration_seconds_count\{method="GET",route="\/things\/:id\/secret",status="403"\} 1/,
    );
    expect(res.text).toMatch(
      /http_request_duration_seconds_count\{method="GET",route="unmatched",status="404"\} 1/,
    );
    expect(res.text).not.toContain('wp-login');
  });
});
