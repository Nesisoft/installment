import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { StuckScheduleRunner, SYSTEM_ACTORS } from '@installment/core';
import type { Env } from '../config/env.validation';
import { captureAlert, captureWorkerError } from '../common/alerting';

const ACTOR = { actorId: SYSTEM_ACTORS.RECONCILER, actorType: 'system' as const };

/**
 * How long a schedule may sit in `processing` before we treat it as stuck.
 * Comfortably beyond the verify-poll budget (~45 min), so this only sees rows
 * the normal recovery path has already given up on.
 */
const STUCK_AFTER_MS = 90 * 60_000;

/**
 * Stuck-schedule reconciliation (hourly).
 *
 * An installment that enters `processing` and never receives an outcome is
 * invisible to every other sweep: the debit scheduler selects pending/due, the
 * retry queue never sees it, and grace-expiry ignores it. The customer may or
 * may not have been debited and nobody would ever find out. This drains that
 * set and alerts on anything it cannot resolve automatically.
 */
@Injectable()
export class StuckScheduleCron {
  private readonly enabled: boolean;

  constructor(
    private readonly runner: StuckScheduleRunner,
    config: ConfigService<Env, true>,
    @InjectPinoLogger(StuckScheduleCron.name) private readonly logger: PinoLogger,
  ) {
    this.enabled = config.get('ENABLE_SCHEDULED_WORKERS', { infer: true });
  }

  @Cron(CronExpression.EVERY_HOUR, { name: 'stuck-schedule' })
  async run(): Promise<void> {
    if (!this.enabled) return;
    try {
      const stuckBefore = new Date(Date.now() - STUCK_AFTER_MS);
      const summary = await this.runner.sweep(stuckBefore, ACTOR);
      if (summary.checked === 0) return;

      this.logger.info(
        {
          checked: summary.checked,
          resolved: summary.resolved,
          pending: summary.pending,
          unresolved: summary.unresolved,
          orphaned: summary.orphaned,
        },
        'stuck-schedule sweep complete',
      );

      // Anything left indeterminate is money we cannot account for.
      const needsHuman = summary.unresolved + summary.orphaned;
      if (needsHuman > 0) {
        captureAlert('stuck installments need manual reconciliation', 'error', {
          unresolved: summary.unresolved,
          orphaned: summary.orphaned,
          scheduleIds: summary.outcomes
            .filter((o) => o.outcome === 'unresolved' || o.outcome === 'orphaned')
            .map((o) => o.scheduleId)
            .slice(0, 20),
        });
      }
    } catch (err) {
      this.logger.error({ err }, 'stuck-schedule sweep failed');
      captureWorkerError(err, 'stuck-schedule');
    }
  }
}
