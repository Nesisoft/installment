import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { MetricsController } from './metrics.controller';
import { OpsMetricsCollector } from './ops-metrics.collector';
import { HttpMetricsMiddleware } from './http-metrics.middleware';

/** `GET /metrics` and what it serves. See infra/observability/README.md. */
@Module({
  controllers: [MetricsController],
  providers: [OpsMetricsCollector],
})
export class ObservabilityModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(HttpMetricsMiddleware).forRoutes('{*splat}');
  }
}
