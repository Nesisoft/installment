import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { FulfilmentService } from '@installment/commerce';
import { SYSTEM_ACTORS } from '@installment/core';
import { captureWorkerError } from '../common/alerting';
import { recordJobRun } from '../observability/metrics';

const SYSTEM_ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

/**
 * Closes delivered orders whose return window has run out.
 *
 * `completed` is the state that says nobody is coming back: the customer can no
 * longer return the goods and the merchant's escrow can be released. Nothing
 * else moves an order out of `delivered`, so without this sweep every delivered
 * order would sit there forever and the reserve would never come free.
 *
 * Hourly rather than daily because the window is stamped as a timestamp, not a
 * date — an order delivered at 14:00 with a 7-day window closes at 14:00, and a
 * daily sweep would hold the merchant's money for up to a day longer than the
 * terms say.
 *
 * Safe to run repeatedly: each order is closed under a status guard, so one
 * that moved underneath the sweep is skipped rather than closed twice.
 */
@Injectable()
export class ReturnWindowCron {
  private readonly logger = new Logger(ReturnWindowCron.name);

  constructor(@Inject(FulfilmentService) private readonly fulfilment: FulfilmentService) {}

  @Cron(CronExpression.EVERY_HOUR, { name: 'return-window-close' })
  async run(): Promise<void> {
    let outcome: 'success' | 'failure' = 'success';
    try {
      const closed = await this.fulfilment.completeElapsedReturnWindows(SYSTEM_ACTOR);
      if (closed.length > 0) {
        this.logger.log(`return window closed on ${closed.length} order(s)`);
      }
    } catch (err) {
      outcome = 'failure';
      // A failed sweep must not take the process down; the next run picks up
      // exactly the same set, because the query is driven by order state.
      this.logger.error(`return window sweep failed: ${(err as Error).message}`);
      captureWorkerError(err, 'return-window-close');
    } finally {
      recordJobRun('return-window-close', outcome);
    }
  }
}
