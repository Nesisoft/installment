import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { ReconciliationService } from '@installment/core';
import type { Env } from '../config/env.validation';
import { captureAlert, captureWorkerError } from '../common/alerting';
import { recordJobRun } from '../observability/metrics';

const RECONCILE_BATCH_LIMIT = 100;

/**
 * In-flight payout sweeper (every 15 minutes). Verifies pending_confirmation +
 * unknown payouts against Paystack and drives each to a terminal state via
 * SettlementService.confirmPayout. Bounded per-tick to avoid blocking the
 * scheduler; backlog drains across ticks.
 */
@Injectable()
export class ReconciliationCron {
  private readonly enabled: boolean;

  constructor(
    private readonly reconciliation: ReconciliationService,
    config: ConfigService<Env, true>,
    @InjectPinoLogger(ReconciliationCron.name) private readonly logger: PinoLogger,
  ) {
    this.enabled = config.get('ENABLE_SCHEDULED_WORKERS', { infer: true });
  }

  @Cron(CronExpression.EVERY_30_MINUTES, { name: 'payout-reconciliation' })
  async run(): Promise<void> {
    if (!this.enabled) return;
    let outcome: 'success' | 'failure' = 'success';
    try {
      const summary = await this.reconciliation.reconcilePendingPayouts({
        limit: RECONCILE_BATCH_LIMIT,
      });
      // Only log when something actually moved or there's work that didn't.
      if (summary.checked === 0) return;
      this.logger.info(
        {
          checked: summary.checked,
          settled: summary.settled,
          failed: summary.failed,
          stillPending: summary.stillPending,
          unresolved: summary.unresolved,
        },
        'payout reconciliation sweep complete',
      );
      // The sweep now survives a row it cannot resolve rather than throwing,
      // so an unresolved payout no longer surfaces as a failed run. It is
      // money in flight that nobody has confirmed — mirror what the refund
      // reconciler already does and say so.
      if (summary.unresolved > 0) {
        captureAlert('payouts could not be reconciled', 'error', {
          unresolved: summary.unresolved,
          references: summary.results
            .filter((r) => r.outcome === 'unresolved')
            .map((r) => r.reference),
        });
      }
    } catch (err) {
      outcome = 'failure';
      this.logger.error({ err }, 'payout reconciliation sweep failed');
      captureWorkerError(err, 'reconciliation');
    } finally {
      recordJobRun('payout-reconciliation', outcome);
    }
  }
}
