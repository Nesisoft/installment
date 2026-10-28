import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { SettlementService, type DailySettlementSummary } from '@installment/core';
import type { Env } from '../config/env.validation';
import { captureAlert, captureWorkerError } from '../common/alerting';
import { recordJobRun } from '../observability/metrics';

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
    let outcome: 'success' | 'failure' = 'success';
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
      this.alertOnPayoutsThatDidNotGoOut(summary);
    } catch (err) {
      outcome = 'failure';
      // Cron must never throw — the next tick will retry. Pager logs the error.
      this.logger.error({ err }, 'daily settlement run failed');
      captureWorkerError(err, 'settlement');
    } finally {
      recordJobRun('daily-settlement', outcome);
    }
  }

  /**
   * A payout that did not go out has to be heard about, with the reason.
   *
   * Checked against Paystack test mode (2026-10-20): on this account every
   * transfer is refused with "You cannot initiate third party payouts as a
   * starter business". Each is parked `unknown` and reversed by
   * reconciliation, and this run only logged counts — so no merchant would be
   * paid, night after night, and nothing would say so.
   *
   * Error level when not one payout went out: every attempt refused is an
   * account or configuration problem, not one merchant's bad account number.
   */
  private alertOnPayoutsThatDidNotGoOut(summary: DailySettlementSummary): void {
    const attempted = summary.results.filter((r) => r.status !== 'skipped');
    const troubled = attempted.filter((r) => r.status === 'failed' || r.status === 'unknown');
    if (troubled.length === 0) return;

    const byReason = new Map<string, { reason: string; payouts: number; pesewas: number }>();
    for (const r of troubled) {
      const reason = r.reason ?? 'no reason recorded';
      const entry = byReason.get(reason) ?? { reason, payouts: 0, pesewas: 0 };
      entry.payouts += 1;
      entry.pesewas += r.amountPesewas;
      byReason.set(reason, entry);
    }
    const reasons = [...byReason.values()].sort((a, b) => b.payouts - a.payouts);
    const extra = {
      asOfDate: summary.asOfDate,
      reasons,
      payouts: troubled.map((r) => ({
        merchantId: r.merchantId,
        status: r.status,
        amountPesewas: r.amountPesewas,
        reference: r.reference,
      })),
    };

    if (troubled.length === attempted.length) {
      captureAlert(
        `No merchant payout went out on ${summary.asOfDate} — ${troubled.length} refused or unconfirmed, most often: "${reasons[0]!.reason}"`,
        'error',
        extra,
      );
      return;
    }
    captureAlert(
      `${troubled.length} merchant payout${troubled.length === 1 ? '' : 's'} did not go out on ${summary.asOfDate}`,
      'warning',
      extra,
    );
  }
}
