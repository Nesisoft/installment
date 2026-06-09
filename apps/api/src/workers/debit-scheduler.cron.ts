import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { DebitRunner, SYSTEM_ACTORS } from '@installment/core';
import type { Env } from '../config/env.validation';
import { captureWorkerError } from '../common/alerting';

const ACTOR = { actorId: SYSTEM_ACTORS.SCHEDULER, actorType: 'system' as const };

/**
 * Hourly auto-debit sweep. Picks up installments due for a first attempt
 * (pending / due, on or past their due date) and charges each via the
 * customer's saved MoMo. Retries (retry_scheduled rows) are owned by the BullMQ
 * retry queue, not this sweep, so they never double-charge.
 */
@Injectable()
export class DebitSchedulerCron {
  private readonly enabled: boolean;

  constructor(
    private readonly debitRunner: DebitRunner,
    config: ConfigService<Env, true>,
    @InjectPinoLogger(DebitSchedulerCron.name) private readonly logger: PinoLogger,
  ) {
    this.enabled = config.get('ENABLE_SCHEDULED_WORKERS', { infer: true });
  }

  @Cron(CronExpression.EVERY_HOUR, { name: 'debit-scheduler' })
  async run(): Promise<void> {
    if (!this.enabled) return;
    try {
      const summary = await this.debitRunner.sweepDue(new Date(), ACTOR);
      if (summary.attempted === 0) return;
      this.logger.info(
        {
          asOfDate: summary.asOfDate,
          attempted: summary.attempted,
          succeeded: summary.succeeded,
          pending: summary.pending,
          failed: summary.failed,
          unknown: summary.unknown,
          skipped: summary.skipped,
        },
        'auto-debit sweep complete',
      );
    } catch (err) {
      this.logger.error({ err }, 'auto-debit sweep failed');
      captureWorkerError(err, 'debit-scheduler');
    }
  }
}
