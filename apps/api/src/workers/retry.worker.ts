import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Worker } from 'bullmq';
import {
  DebitRunner,
  PaymentLinkDispatcher,
  SYSTEM_ACTORS,
  type DebitAttemptOutcome,
  type PaymentLinkOutcome,
  type RetryJob,
} from '@installment/core';
import type { Env } from '../config/env.validation';
import { RETRY_QUEUE, createQueueConnection } from './retry-queue';

const ACTOR = { actorId: SYSTEM_ACTORS.DEBIT_WORKER, actorType: 'system' as const };

export type RetryProcessResult = DebitAttemptOutcome | PaymentLinkOutcome;

/**
 * Consumes the BullMQ retry queue. `auto_debit` jobs re-attempt the charge via
 * {@link DebitRunner}; `payment_link` jobs (the final fallback step) are logged
 * for now — link dispatch over SMS is a later slice, and the schedule stays in
 * `retry_scheduled` for the grace-expiry worker to escalate.
 *
 * Only starts consuming when ENABLE_SCHEDULED_WORKERS is set, so dev / tests
 * don't drain the queue. The producer ({@link BullMqRetryScheduler}) always
 * enqueues, so jobs are durable until a worker turns on.
 */
@Injectable()
export class RetryWorker implements OnModuleInit, OnModuleDestroy {
  private worker?: Worker<RetryJob>;
  private readonly enabled: boolean;

  constructor(
    private readonly debitRunner: DebitRunner,
    private readonly paymentLink: PaymentLinkDispatcher,
    private readonly config: ConfigService<Env, true>,
    @InjectPinoLogger(RetryWorker.name) private readonly logger: PinoLogger,
  ) {
    this.enabled = config.get('ENABLE_SCHEDULED_WORKERS', { infer: true });
  }

  onModuleInit(): void {
    if (!this.enabled) return;
    this.worker = new Worker<RetryJob>(RETRY_QUEUE, (job) => this.process(job.data), {
      connection: createQueueConnection(this.config.get('REDIS_URL', { infer: true })),
      concurrency: 5,
    });
    this.worker.on('failed', (job, err) =>
      this.logger.error({ err, jobId: job?.id }, 'retry job threw'),
    );
  }

  /** Processes one retry job. Extracted so it can be unit-tested without BullMQ. */
  async process(job: RetryJob): Promise<RetryProcessResult> {
    if (job.channel === 'payment_link') {
      const linkOutcome = await this.paymentLink.dispatch(job.scheduleId, job.attempt);
      this.logger.info(
        {
          scheduleId: job.scheduleId,
          attempt: job.attempt,
          outcome: linkOutcome.status,
          reason: linkOutcome.reason,
        },
        'payment_link dispatch complete',
      );
      return linkOutcome;
    }

    const outcome = await this.debitRunner.attemptAutoDebit(job.scheduleId, ACTOR);
    this.logger.info(
      {
        scheduleId: job.scheduleId,
        attempt: job.attempt,
        outcome: outcome.status,
        reason: outcome.reason,
      },
      'retry attempt complete',
    );
    return outcome;
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
