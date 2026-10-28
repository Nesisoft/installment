import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { LedgerIntegrityService } from '@installment/core';
import type { Env } from '../config/env.validation';
import { captureAlert, captureWorkerError } from '../common/alerting';
import {
  ledgerHealthy,
  ledgerUnbalancedTransactions,
  recordJobRun,
} from '../observability/metrics';

/**
 * Hourly ledger integrity check.
 *
 * `LedgerService.record` validates each transaction as it is written, but
 * nothing in the database enforces the invariant globally and nothing watches
 * for drift. Since `ledger_entries` is append-only, a bad posting can never be
 * edited away — only compensated — so the cost of finding it grows with every
 * hour it goes unnoticed. Catching it in the hour it happens is the difference
 * between one compensating entry and a reconciliation project.
 */
@Injectable()
export class LedgerIntegrityCron {
  private readonly enabled: boolean;

  constructor(
    private readonly integrity: LedgerIntegrityService,
    config: ConfigService<Env, true>,
    @InjectPinoLogger(LedgerIntegrityCron.name) private readonly logger: PinoLogger,
  ) {
    this.enabled = config.get('ENABLE_SCHEDULED_WORKERS', { infer: true });
  }

  @Cron(CronExpression.EVERY_HOUR, { name: 'ledger-integrity' })
  async run(): Promise<void> {
    if (!this.enabled) return;
    let outcome: 'success' | 'failure' = 'success';
    try {
      const report = await this.integrity.report();
      ledgerHealthy.set(report.healthy ? 1 : 0);
      ledgerUnbalancedTransactions.set(report.unbalancedTransactions.length);

      if (report.healthy) {
        this.logger.debug(
          { accounts: report.trialBalance.rows.length },
          'ledger integrity check passed',
        );
        return;
      }

      this.logger.error(
        {
          totalPesewas: report.trialBalance.totalPesewas,
          unbalanced: report.unbalancedTransactions.length,
        },
        'LEDGER INTEGRITY FAILURE',
      );

      // Money-critical: the financial record disagrees with itself.
      captureAlert('ledger integrity check failed', 'error', {
        trialBalanceTotalPesewas: report.trialBalance.totalPesewas,
        unbalancedCount: report.unbalancedTransactions.length,
        // Enough to start the runbook without opening a SQL client.
        transactionIds: report.unbalancedTransactions.slice(0, 20).map((t) => t.transactionId),
        runbook: 'docs/runbooks/ledger-imbalance.md',
      });
    } catch (err) {
      outcome = 'failure';
      this.logger.error({ err }, 'ledger integrity check errored');
      captureWorkerError(err, 'ledger-integrity');
    } finally {
      recordJobRun('ledger-integrity', outcome);
    }
  }
}
