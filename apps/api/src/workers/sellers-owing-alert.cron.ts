import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Money, SellersOwingReport } from '@installment/core';
import type { Env } from '../config/env.validation';
import { captureAlert, captureWorkerError } from '../common/alerting';
import { recordJobRun } from '../observability/metrics';

const ghs = (pesewas: number) => Money.fromPesewas(pesewas).format();

/**
 * Sellers owing Ejua money (daily, 07:20).
 *
 * The alternative to escrow: rather than holding every seller's money until a
 * return window closes, pay them daily and watch for the case escrow exists
 * for — a seller paid out who then owes it back. Two things are worth a page:
 *
 *   - any seller who owes and can no longer be paid out (suspended or
 *     offboarded). Nothing nets their debt off; it is recovered by hand or lost.
 *   - the total owed reaching SELLERS_OWING_ALERT_PESEWAS. That is when holding
 *     payouts for new sellers stops being hypothetical.
 *
 * One alert per run, naming the sellers. Gated by ENABLE_SCHEDULED_WORKERS.
 */
@Injectable()
export class SellersOwingAlertCron {
  private readonly enabled: boolean;
  private readonly threshold: number;

  constructor(
    private readonly report: SellersOwingReport,
    config: ConfigService<Env, true>,
    @InjectPinoLogger(SellersOwingAlertCron.name) private readonly logger: PinoLogger,
  ) {
    this.enabled = config.get('ENABLE_SCHEDULED_WORKERS', { infer: true });
    this.threshold = config.get('SELLERS_OWING_ALERT_PESEWAS', { infer: true });
  }

  @Cron('20 7 * * *', { name: 'sellers-owing-alert' })
  async run(now: Date = new Date()): Promise<void> {
    if (!this.enabled) return;
    let outcome: 'success' | 'failure' = 'success';
    try {
      const rows = await this.report.list(now);
      const summary = this.report.summarise(rows);
      if (summary.sellers === 0) return;

      const overThreshold = summary.owed_pesewas >= this.threshold;
      if (summary.unrecoverable_sellers === 0 && !overThreshold) {
        this.logger.info({ summary }, 'sellers owing Ejua, under the alert threshold');
        return;
      }

      const parts: string[] = [];
      if (summary.unrecoverable_sellers > 0) {
        parts.push(
          `${summary.unrecoverable_sellers} seller${summary.unrecoverable_sellers === 1 ? '' : 's'} who can no longer be paid out owe${summary.unrecoverable_sellers === 1 ? 's' : ''} ${ghs(summary.unrecoverable_pesewas)}`,
        );
      }
      if (overThreshold) {
        parts.push(
          `${summary.sellers} seller${summary.sellers === 1 ? ' owes' : 's owe'} ${ghs(summary.owed_pesewas)} in total`,
        );
      }
      const sellers = rows
        .filter((r) => r.unrecoverable || overThreshold)
        .slice(0, 20)
        .map((r) => ({
          merchant_id: r.merchant_id,
          business_name: r.business_name,
          status: r.status,
          owed_pesewas: r.owed_pesewas,
          seller_age_days: r.seller_age_days,
        }));
      this.logger.warn({ summary, sellers }, 'sellers owing Ejua');
      captureAlert(
        `Sellers owing Ejua: ${parts.join('; ')}`,
        summary.unrecoverable_sellers > 0 ? 'error' : 'warning',
        { summary, sellers },
      );
    } catch (err) {
      outcome = 'failure';
      this.logger.error({ err }, 'sellers owing alert failed');
      captureWorkerError(err, 'sellers-owing-alert');
    } finally {
      recordJobRun('sellers-owing-alert', outcome);
    }
  }
}
