import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { LateFeeService } from '@installment/core';
import type { Env } from '../config/env.validation';
import { captureWorkerError } from '../common/alerting';
import { recordJobRun } from '../observability/metrics';

/**
 * Accrues late fees on instalments past their grace date.
 *
 * Daily rather than hourly: the fee is a whole-weeks-late calculation, so it can
 * only change once a day at most, and running it hourly would be 23 sweeps that
 * find nothing. It runs at 06:00, before the reminder sweep, so a customer whose
 * reminder mentions the amount owed is told the current figure.
 *
 * Safe to run twice: `LateFeeService.accrue` recomputes the fee as a level from
 * weeks elapsed and writes it, rather than adding an increment, so a duplicate
 * run is a no-op instead of a double charge.
 *
 * Gated by ENABLE_SCHEDULED_WORKERS like every other sweep. Safe to repeat is
 * not the same as safe to run from anywhere: a laptop pointed at a shared
 * database with the switch off must not be charging anyone's late fees.
 */
@Injectable()
export class LateFeeCron {
  private readonly logger = new Logger(LateFeeCron.name);
  private readonly enabled: boolean;

  constructor(
    @Inject(LateFeeService) private readonly lateFees: LateFeeService,
    @Inject(ConfigService) config: ConfigService<Env, true>,
  ) {
    this.enabled = config.get('ENABLE_SCHEDULED_WORKERS', { infer: true });
  }

  @Cron(CronExpression.EVERY_DAY_AT_6AM, { name: 'late-fee-accrual' })
  async run(): Promise<void> {
    if (!this.enabled) return;
    let outcome: 'success' | 'failure' = 'success';
    try {
      const applied = await this.lateFees.accrue();
      if (applied.length === 0) return;
      const total = applied.reduce((sum, a) => sum + (a.feePesewas - a.previousFeePesewas), 0);
      this.logger.log(
        `late fees accrued on ${applied.length} instalment(s), +${total} pesewas (${applied.filter((a) => a.capped).length} at cap)`,
      );
    } catch (err) {
      outcome = 'failure';
      // A failed sweep must not take the process down: the fee is recomputed
      // from scratch on the next run, so a missed day self-heals.
      this.logger.error(`late fee accrual failed: ${(err as Error).message}`);
      captureWorkerError(err, 'late-fee-accrual');
    } finally {
      recordJobRun('late-fee-accrual', outcome);
    }
  }
}
