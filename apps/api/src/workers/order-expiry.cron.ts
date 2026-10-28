import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { OrdersService } from '@installment/commerce';
import type { Env } from '../config/env.validation';
import { captureWorkerError } from '../common/alerting';
import { recordJobRun } from '../observability/metrics';

/**
 * Releases the stock held by orders that will never be completed (hourly).
 *
 * Checkout reserves the units it is about to sell, and only a cancel gives them
 * back. Nobody cancels an abandoned basket — the shopper who never paid is,
 * definitionally, not coming back to tidy up — so without this the catalogue
 * loses sellable stock to dead orders one checkout at a time.
 *
 * It also closes a gap between the two expiry paths that already exist.
 * ApplicationExpiryCron expires stale credit applications and an admin can
 * decline one, but neither touches the order: the application goes terminal
 * while its order stays in `pending_approval`, holding stock, with nothing left
 * in the system that could ever approve it.
 *
 * Runs hourly rather than daily because the cost of waiting is unsellable
 * stock, and hourly is cheap — the sweep only touches orders that are already
 * past their deadline.
 */
@Injectable()
export class OrderExpiryCron {
  private readonly enabled: boolean;
  private readonly ttlHours: number;

  constructor(
    private readonly orders: OrdersService,
    config: ConfigService<Env, true>,
    @InjectPinoLogger(OrderExpiryCron.name) private readonly logger: PinoLogger,
  ) {
    this.enabled = config.get('ENABLE_SCHEDULED_WORKERS', { infer: true });
    this.ttlHours = config.get('ORDER_PAYMENT_TTL_HOURS', { infer: true });
  }

  @Cron(CronExpression.EVERY_HOUR, { name: 'order-expiry' })
  async run(): Promise<void> {
    if (!this.enabled) return;
    let outcome: 'success' | 'failure' = 'success';
    try {
      const summary = await this.orders.sweepAbandoned(new Date(), {
        paymentTtlHours: this.ttlHours,
      });
      // Quiet when there is nothing to do: an hourly worker that logs on every
      // run is an hourly worker nobody reads.
      if (summary.checked > 0) {
        this.logger.info({ ...summary, ttlHours: this.ttlHours }, 'order-expiry sweep complete');
      }
      if (summary.failed > 0) {
        // Not an error — a failure here means the order moved on between the
        // select and the cancel, which is the guard working. Worth seeing if it
        // becomes common.
        this.logger.warn({ failed: summary.failed }, 'order-expiry skipped orders that moved');
      }
    } catch (err) {
      outcome = 'failure';
      this.logger.error({ err }, 'order-expiry sweep failed');
      captureWorkerError(err, 'order-expiry');
    } finally {
      recordJobRun('order-expiry', outcome);
    }
  }
}
