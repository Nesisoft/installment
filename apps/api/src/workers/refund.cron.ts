import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { ReconciliationService, RefundService } from '@installment/core';
import type { Env } from '../config/env.validation';
import { captureAlert, captureWorkerError } from '../common/alerting';
import { recordJobRun } from '../observability/metrics';

const SEND_BATCH_LIMIT = 50;
const RECONCILE_BATCH_LIMIT = 100;

/**
 * Sends refunds the customer is owed, and resolves the ones already in flight.
 *
 * This worker is what makes a refund real. `refundInstallment` writes the books
 * and records the obligation; without something running this loop the customer
 * never receives their money and nothing in the system complains.
 *
 * Runs every 5 minutes rather than the 30 the payout reconciler uses: this is
 * money owed to a customer who is waiting for it, and the delay is the whole
 * cost of doing the provider call out of band.
 */
@Injectable()
export class RefundCron {
  private readonly enabled: boolean;

  constructor(
    private readonly refunds: RefundService,
    private readonly reconciliation: ReconciliationService,
    config: ConfigService<Env, true>,
    @InjectPinoLogger(RefundCron.name) private readonly logger: PinoLogger,
  ) {
    this.enabled = config.get('ENABLE_SCHEDULED_WORKERS', { infer: true });
  }

  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'refund-disbursement' })
  async run(): Promise<void> {
    if (!this.enabled) return;
    let outcome: 'success' | 'failure' = 'success';
    try {
      const sent = await this.refunds.runSweep(SEND_BATCH_LIMIT);
      if (sent.attempted > 0) {
        this.logger.info(
          {
            attempted: sent.attempted,
            succeeded: sent.succeeded,
            pending: sent.pending,
            failed: sent.failed,
            unknown: sent.unknown,
          },
          'refund disbursement sweep complete',
        );
      }
      // A refund we could not send is a customer who has not been paid back.
      // Surface it rather than letting it retry quietly forever.
      if (sent.unknown > 0 || sent.failed > 0) {
        captureAlert('refunds could not be sent', 'error', {
          unknown: sent.unknown,
          failed: sent.failed,
          references: sent.results
            .filter((r) => r.outcome === 'unknown' || r.outcome === 'failed')
            .map((r) => r.reference),
        });
      }

      const reconciled = await this.reconciliation.reconcilePendingRefunds({
        limit: RECONCILE_BATCH_LIMIT,
      });
      if (reconciled.checked > 0) {
        this.logger.info(
          {
            checked: reconciled.checked,
            settled: reconciled.settled,
            failed: reconciled.failed,
            stillPending: reconciled.stillPending,
            unresolved: reconciled.unresolved,
          },
          'refund reconciliation sweep complete',
        );
      }
      if (reconciled.unresolved > 0) {
        captureAlert('refunds could not be reconciled', 'error', {
          unresolved: reconciled.unresolved,
          references: reconciled.results
            .filter((r) => r.outcome === 'unresolved')
            .map((r) => r.reference),
        });
      }
    } catch (err) {
      outcome = 'failure';
      this.logger.error({ err }, 'refund sweep failed');
      captureWorkerError(err, 'refunds');
    } finally {
      recordJobRun('refund-disbursement', outcome);
    }
  }
}
