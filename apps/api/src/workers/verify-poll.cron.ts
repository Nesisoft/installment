import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { SYSTEM_ACTORS, VerifyRunner } from '@installment/core';
import type { Env } from '../config/env.validation';
import { captureWorkerError } from '../common/alerting';
import { recordJobRun } from '../observability/metrics';

const ACTOR = { actorId: SYSTEM_ACTORS.VERIFY_WORKER, actorType: 'system' as const };

/**
 * How long an attempt stays unresolved before we poll — gives the webhook a
 * head start. Deliberately generous: MoMo approvals routinely outlast a couple
 * of minutes, and polling too eagerly burns the verify budget before the
 * customer has even seen the prompt.
 */
const STALE_AFTER_MS = 15 * 60_000;

/**
 * Verify-poll sweep (every 5 minutes). Drains in-flight MoMo attempts whose
 * webhook never arrived by re-verifying them against Paystack, so a dropped
 * webhook can't strand an installment in `processing`. Each attempt is polled a
 * bounded number of times (MAX_VERIFY_POLLS) before it times out to `failed`.
 */
@Injectable()
export class VerifyPollCron {
  private readonly enabled: boolean;

  constructor(
    private readonly verifyRunner: VerifyRunner,
    config: ConfigService<Env, true>,
    @InjectPinoLogger(VerifyPollCron.name) private readonly logger: PinoLogger,
  ) {
    this.enabled = config.get('ENABLE_SCHEDULED_WORKERS', { infer: true });
  }

  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'verify-poll' })
  async run(): Promise<void> {
    if (!this.enabled) return;
    let outcome: 'success' | 'failure' = 'success';
    try {
      const staleBefore = new Date(Date.now() - STALE_AFTER_MS);
      const summary = await this.verifyRunner.sweepStale(staleBefore, ACTOR);
      if (summary.checked === 0) return;
      this.logger.info(
        {
          checked: summary.checked,
          succeeded: summary.succeeded,
          failed: summary.failed,
          pending: summary.pending,
          unknown: summary.unknown,
          skipped: summary.skipped,
        },
        'verify-poll sweep complete',
      );
    } catch (err) {
      outcome = 'failure';
      this.logger.error({ err }, 'verify-poll sweep failed');
      captureWorkerError(err, 'verify-poll');
    } finally {
      recordJobRun('verify-poll', outcome);
    }
  }
}
