import IORedis, { type Redis } from 'ioredis';

/** BullMQ queue that carries failed-debit retry jobs (see RetryScheduler port). */
export const RETRY_QUEUE = 'installment-retries';

/**
 * A dedicated Redis connection for BullMQ. BullMQ requires
 * `maxRetriesPerRequest: null` on its blocking connections, so we never share
 * the app's ioredis client with the queue/worker.
 */
export function createQueueConnection(redisUrl: string): Redis {
  return new IORedis(redisUrl, { maxRetriesPerRequest: null });
}
