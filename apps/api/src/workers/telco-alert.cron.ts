import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { TelcoHealthMonitor } from '@installment/core';
import type { Env } from '../config/env.validation';
import { captureAlert } from '../common/alerting';

/**
 * Telco health alerter (every 5 minutes). Snapshots Mobile Money network
 * health and raises a Sentry alert for any telco that is degraded or down, so
 * ops is paged rather than discovering it from the dashboard. Gated by
 * ENABLE_SCHEDULED_WORKERS.
 */
@Injectable()
export class TelcoAlertCron {
  private readonly enabled: boolean;

  constructor(
    private readonly telco: TelcoHealthMonitor,
    config: ConfigService<Env, true>,
    @InjectPinoLogger(TelcoAlertCron.name) private readonly logger: PinoLogger,
  ) {
    this.enabled = config.get('ENABLE_SCHEDULED_WORKERS', { infer: true });
  }

  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'telco-health-alert' })
  async run(): Promise<void> {
    if (!this.enabled) return;
    try {
      const snapshot = await this.telco.snapshot();
      for (const h of snapshot) {
        if (h.status !== 'degraded' && h.status !== 'down') continue;
        const level = h.status === 'down' ? 'error' : 'warning';
        this.logger.warn(
          { telco: h.telco, status: h.status, successRate: h.successRate, attempts: h.attempts },
          'telco health alert',
        );
        captureAlert(`MoMo telco ${h.telco.toUpperCase()} is ${h.status}`, level, {
          telco: h.telco,
          successRate: h.successRate,
          attempts: h.attempts,
        });
      }
    } catch (err) {
      this.logger.error({ err }, 'telco health alert sweep failed');
    }
  }
}
