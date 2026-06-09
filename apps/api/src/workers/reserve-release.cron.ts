import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { ReserveReleaseService } from '@installment/core';
import type { Env } from '../config/env.validation';
import { captureWorkerError } from '../common/alerting';

/**
 * Daily reserve maturation sweep (07:00 UTC, an hour after the settlement
 * batch so any matured reserve picked up here lands on the next day's payout).
 * Walks every merchant with open held_reserves rows and releases what each
 * row's policy says is due. Cap-by-ledger-balance keeps refunds safe.
 */
@Injectable()
export class ReserveReleaseCron {
  private readonly enabled: boolean;

  constructor(
    private readonly reserves: ReserveReleaseService,
    config: ConfigService<Env, true>,
    @InjectPinoLogger(ReserveReleaseCron.name) private readonly logger: PinoLogger,
  ) {
    this.enabled = config.get('ENABLE_SCHEDULED_WORKERS', { infer: true });
  }

  @Cron(CronExpression.EVERY_DAY_AT_7AM, { name: 'reserve-release-sweep' })
  async run(): Promise<void> {
    if (!this.enabled) return;
    try {
      const summary = await this.reserves.runSweep(new Date());
      this.logger.info(
        {
          asOf: summary.asOf,
          merchantsChecked: summary.merchantsChecked,
          totalReleasedPesewas: summary.totalReleasedPesewas,
          merchantsWithRelease: summary.perMerchant.filter((m) => m.totalReleasedPesewas > 0)
            .length,
        },
        'reserve release sweep complete',
      );
    } catch (err) {
      this.logger.error({ err }, 'reserve release sweep failed');
      captureWorkerError(err, 'reserve-release');
    }
  }
}
