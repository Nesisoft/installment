import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { SettlementService } from '@installment/core';
import type { Env } from '../config/env.validation';

/**
 * Daily merchant payout batch (06:00 UTC). Each merchant we owe gets settled
 * idempotently (per merchant_id + as_of_date), so a missed day or a re-run is
 * safe. ENABLE_SCHEDULED_WORKERS gates it — keep OFF in tests / local
 * single-instance dev, ON exactly once per production deployment.
 */
@Injectable()
export class SettlementCron {
  private readonly enabled: boolean;

  constructor(
    private readonly settlements: SettlementService,
    config: ConfigService<Env, true>,
    @InjectPinoLogger(SettlementCron.name) private readonly logger: PinoLogger,
  ) {
    this.enabled = config.get('ENABLE_SCHEDULED_WORKERS', { infer: true });
  }

  @Cron(CronExpression.EVERY_DAY_AT_6AM, { name: 'daily-settlement' })
  async run(): Promise<void> {
    if (!this.enabled) return;
    try {
      const summary = await this.settlements.runDailySettlement(new Date());
      this.logger.info(
        {
          asOfDate: summary.asOfDate,
          merchantsChecked: summary.results.length,
          totalSettledPesewas: summary.totalSettledPesewas,
          settled: summary.results.filter((r) => r.status === 'settled').length,
          failed: summary.results.filter((r) => r.status === 'failed').length,
          pending: summary.results.filter((r) => r.status === 'pending_confirmation').length,
          unknown: summary.results.filter((r) => r.status === 'unknown').length,
          skipped: summary.results.filter((r) => r.status === 'skipped').length,
        },
        'daily settlement run complete',
      );
    } catch (err) {
      // Cron must never throw — the next tick will retry. Pager logs the error.
      this.logger.error({ err }, 'daily settlement run failed');
    }
  }
}
