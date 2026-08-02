import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { ApplicationsService, SYSTEM_ACTORS } from '@installment/core';
import type { Env } from '../config/env.validation';
import { captureWorkerError } from '../common/alerting';

const ACTOR = { actorId: SYSTEM_ACTORS.SCHEDULER, actorType: 'worker' as const };

/**
 * Expires applications past their `expires_at` (hourly).
 *
 * `ApplicationsService.expireOverdue` was implemented and the partial index
 * `applications_pending_expiry_idx` was built for it, but nothing ever called
 * it — so a pending or counter-offered application stayed live indefinitely.
 * That matters for credit control: the exposure collector counts non-terminal
 * applications, so stale ones inflate a customer's apparent commitments and
 * quietly suppress their limit.
 */
@Injectable()
export class ApplicationExpiryCron {
  private readonly enabled: boolean;

  constructor(
    private readonly applications: ApplicationsService,
    config: ConfigService<Env, true>,
    @InjectPinoLogger(ApplicationExpiryCron.name) private readonly logger: PinoLogger,
  ) {
    this.enabled = config.get('ENABLE_SCHEDULED_WORKERS', { infer: true });
  }

  @Cron(CronExpression.EVERY_HOUR, { name: 'application-expiry' })
  async run(): Promise<void> {
    if (!this.enabled) return;
    try {
      const expired = await this.applications.expireOverdue(new Date(), ACTOR);
      if (expired > 0) {
        this.logger.info({ expired }, 'application-expiry sweep complete');
      }
    } catch (err) {
      this.logger.error({ err }, 'application-expiry sweep failed');
      captureWorkerError(err, 'application-expiry');
    }
  }
}
