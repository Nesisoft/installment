import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { DeclineReasonReport } from '@installment/core';
import type { Env } from '../config/env.validation';
import { captureAlert, captureWorkerError } from '../common/alerting';
import { recordJobRun } from '../observability/metrics';

const DAY_MS = 86_400_000;

/**
 * Decline reasons the classifier does not recognise (daily, 07:10).
 *
 * `PAYSTACK_DECLINE_MAP` is keyed on snake_case tokens; whether real Paystack
 * declines arrive as those tokens or as prose has never been checked against a
 * real decline. If prose, every decline classifies as `ambiguous` and is
 * retried — a blocked card included — and nothing anywhere said so. This says
 * so, once a day, with the exact strings and counts needed to fix the map.
 *
 * One alert per run rather than per decline: if the answer is "all of them",
 * a per-decline alert would page on every failed charge. Gated by
 * ENABLE_SCHEDULED_WORKERS.
 */
@Injectable()
export class DeclineReasonAlertCron {
  private readonly enabled: boolean;

  constructor(
    private readonly report: DeclineReasonReport,
    config: ConfigService<Env, true>,
    @InjectPinoLogger(DeclineReasonAlertCron.name) private readonly logger: PinoLogger,
  ) {
    this.enabled = config.get('ENABLE_SCHEDULED_WORKERS', { infer: true });
  }

  @Cron('10 7 * * *', { name: 'decline-reason-alert' })
  async run(now: Date = new Date()): Promise<void> {
    if (!this.enabled) return;
    let outcome: 'success' | 'failure' = 'success';
    try {
      const rows = await this.report.unrecognised({ since: new Date(now.getTime() - DAY_MS) });
      if (rows.length === 0) return;
      const reasons = rows.map((r) => ({ reason: r.reason, attempts: r.attempts }));
      this.logger.warn({ reasons }, 'unrecognised Paystack decline reasons');
      captureAlert(
        `${rows.length} Paystack decline reason${rows.length === 1 ? '' : 's'} not in the classifier map — treated as ambiguous and retried`,
        'warning',
        { reasons },
      );
    } catch (err) {
      outcome = 'failure';
      this.logger.error({ err }, 'decline reason alert failed');
      captureWorkerError(err, 'decline-reason-alert');
    } finally {
      recordJobRun('decline-reason-alert', outcome);
    }
  }
}
