import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { ReminderRunner } from '@installment/core';
import type { Env } from '../config/env.validation';
import { captureWorkerError } from '../common/alerting';
import { recordJobRun } from '../observability/metrics';

const DAY_MS = 86_400_000;

/**
 * Pre-debit reminder sweep (daily 17:00 UTC — evening in Ghana, the day before
 * a debit). Texts customers whose installment is due tomorrow so their MoMo
 * wallet is funded. Gated by ENABLE_SCHEDULED_WORKERS.
 */
@Injectable()
export class ReminderCron {
  private readonly enabled: boolean;

  constructor(
    private readonly reminders: ReminderRunner,
    config: ConfigService<Env, true>,
    @InjectPinoLogger(ReminderCron.name) private readonly logger: PinoLogger,
  ) {
    this.enabled = config.get('ENABLE_SCHEDULED_WORKERS', { infer: true });
  }

  @Cron(CronExpression.EVERY_DAY_AT_5PM, { name: 'pre-debit-reminders' })
  async run(): Promise<void> {
    if (!this.enabled) return;
    let outcome: 'success' | 'failure' = 'success';
    try {
      const tomorrow = new Date(Date.now() + DAY_MS).toISOString().slice(0, 10);
      const summary = await this.reminders.sendUpcomingReminders(tomorrow);
      if (summary.candidates === 0) return;
      this.logger.info(
        {
          forDate: summary.forDate,
          candidates: summary.candidates,
          sent: summary.sent,
          skipped: summary.skipped,
        },
        'pre-debit reminders sent',
      );
    } catch (err) {
      outcome = 'failure';
      this.logger.error({ err }, 'pre-debit reminder sweep failed');
      captureWorkerError(err, 'reminder');
    } finally {
      recordJobRun('pre-debit-reminders', outcome);
    }
  }
}
