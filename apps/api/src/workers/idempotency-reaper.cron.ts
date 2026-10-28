import { Inject, Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { DrizzleIdempotencyStore } from '@installment/core';
import type { Database } from '@installment/db';
import { DRIZZLE } from '../db/db.module';
import type { Env } from '../config/env.validation';
import { captureWorkerError } from '../common/alerting';
import { recordJobRun } from '../observability/metrics';

/**
 * Purges expired idempotency keys (daily).
 *
 * Nothing ever deleted from `idempotency_keys`, so the table would grow
 * without bound now that the interceptor writes a row per money-mutating
 * request. `idempotency_keys_expiry_idx` exists for exactly this sweep.
 */
@Injectable()
export class IdempotencyReaperCron {
  private readonly enabled: boolean;
  private readonly store: DrizzleIdempotencyStore;

  constructor(
    @Inject(DRIZZLE) db: Database,
    config: ConfigService<Env, true>,
    @InjectPinoLogger(IdempotencyReaperCron.name) private readonly logger: PinoLogger,
  ) {
    this.enabled = config.get('ENABLE_SCHEDULED_WORKERS', { infer: true });
    this.store = new DrizzleIdempotencyStore(db);
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'idempotency-reaper' })
  async run(): Promise<void> {
    if (!this.enabled) return;
    let outcome: 'success' | 'failure' = 'success';
    try {
      const purged = await this.store.purgeExpired();
      if (purged > 0) {
        this.logger.info({ purged }, 'idempotency-reaper purged expired keys');
      }
    } catch (err) {
      outcome = 'failure';
      this.logger.error({ err }, 'idempotency-reaper failed');
      captureWorkerError(err, 'idempotency-reaper');
    } finally {
      recordJobRun('idempotency-reaper', outcome);
    }
  }
}
