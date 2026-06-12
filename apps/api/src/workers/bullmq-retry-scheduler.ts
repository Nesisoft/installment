import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import type { RetryJob, RetryScheduler } from '@installment/core';
import type { Env } from '../config/env.validation';
import { RETRY_QUEUE, createQueueConnection } from './retry-queue';

/**
 * BullMQ implementation of the core {@link RetryScheduler} port. PaymentService
 * calls `scheduleRetry` after a retryable decline; the delayed job fires after
 * the policy backoff and the RetryWorker re-attempts the charge.
 *
 * The jobId is deterministic per (schedule, attempt), so a double-enqueue (e.g.
 * a webhook + a verify poll both landing the same failure) is de-duplicated by
 * BullMQ rather than charging twice.
 */
@Injectable()
export class BullMqRetryScheduler implements RetryScheduler, OnModuleDestroy {
  private readonly queue: Queue<RetryJob>;

  constructor(config: ConfigService<Env, true>) {
    this.queue = new Queue<RetryJob>(RETRY_QUEUE, {
      connection: createQueueConnection(config.get('REDIS_URL', { infer: true })),
    });
  }

  async scheduleRetry(job: RetryJob): Promise<void> {
    await this.queue.add('retry', job, {
      delay: job.delayMs,
      jobId: `retry:${job.scheduleId}:${job.attempt}`,
      removeOnComplete: true,
      removeOnFail: 1_000,
      attempts: 1,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}
