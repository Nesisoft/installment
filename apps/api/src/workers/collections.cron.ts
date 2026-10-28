import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { CollectionsService, SYSTEM_ACTORS } from '@installment/core';
import type { Env } from '../config/env.validation';
import { captureWorkerError } from '../common/alerting';
import { recordJobRun } from '../observability/metrics';

const ACTOR = { actorId: SYSTEM_ACTORS.COLLECTIONS_BOT, actorType: 'system' as const };

/**
 * Daily collections sweep (08:00 UTC). Escalates due/failed installments past
 * their grace date to overdue, opens a collections case for each overdue
 * installment, and advances open cases through the dunning stages by age.
 */
@Injectable()
export class CollectionsCron {
  private readonly enabled: boolean;

  constructor(
    private readonly collections: CollectionsService,
    config: ConfigService<Env, true>,
    @InjectPinoLogger(CollectionsCron.name) private readonly logger: PinoLogger,
  ) {
    this.enabled = config.get('ENABLE_SCHEDULED_WORKERS', { infer: true });
  }

  @Cron(CronExpression.EVERY_DAY_AT_8AM, { name: 'collections-sweep' })
  async run(): Promise<void> {
    if (!this.enabled) return;
    let outcome: 'success' | 'failure' = 'success';
    try {
      const summary = await this.collections.runSweep(ACTOR, new Date());
      if (
        summary.settledClosed === 0 &&
        summary.graceExpired === 0 &&
        summary.casesOpened === 0 &&
        summary.stagesAdvanced === 0 &&
        summary.writtenOff === 0
      ) {
        return; // nothing moved
      }
      this.logger.info(
        {
          settledClosed: summary.settledClosed,
          graceExpired: summary.graceExpired,
          casesOpened: summary.casesOpened,
          stagesAdvanced: summary.stagesAdvanced,
          writtenOff: summary.writtenOff,
        },
        'collections sweep complete',
      );
    } catch (err) {
      outcome = 'failure';
      this.logger.error({ err }, 'collections sweep failed');
      captureWorkerError(err, 'collections');
    } finally {
      recordJobRun('collections-sweep', outcome);
    }
  }
}
