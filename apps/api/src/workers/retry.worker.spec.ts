import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { PinoLogger } from 'nestjs-pino';
import type { RetryJob } from '@installment/core';
import { RetryWorker } from './retry.worker';
import type { Env } from '../config/env.validation';

function makeConfig(): ConfigService<Env, true> {
  // Disabled so onModuleInit never constructs a real BullMQ Worker.
  return { get: vi.fn(() => false) } as unknown as ConfigService<Env, true>;
}
function makeLogger(): PinoLogger {
  return { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as unknown as PinoLogger;
}

const autoDebitJob: RetryJob = {
  scheduleId: 's1',
  attempt: 2,
  channel: 'auto_debit',
  delayMs: 14_400_000,
};
const linkJob: RetryJob = {
  scheduleId: 's1',
  attempt: 4,
  channel: 'payment_link',
  delayMs: 172_800_000,
};

describe('RetryWorker.process', () => {
  it('re-attempts the auto-debit and returns the outcome', async () => {
    const attemptAutoDebit = vi.fn(async () => ({
      scheduleId: 's1',
      status: 'succeeded' as const,
      providerReference: 'ps-1',
    }));
    const dispatch = vi.fn();
    const worker = new RetryWorker(
      { attemptAutoDebit } as never,
      { dispatch } as never,
      makeConfig(),
      makeLogger(),
    );

    const result = await worker.process(autoDebitJob);

    expect(attemptAutoDebit).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ actorType: 'system' }),
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(result).toMatchObject({ scheduleId: 's1', status: 'succeeded' });
  });

  it('dispatches a payment link for payment_link jobs', async () => {
    const attemptAutoDebit = vi.fn();
    const dispatch = vi.fn(async () => ({
      scheduleId: 's1',
      status: 'sent' as const,
      url: 'https://paystack/pay/abc',
    }));
    const worker = new RetryWorker(
      { attemptAutoDebit } as never,
      { dispatch } as never,
      makeConfig(),
      makeLogger(),
    );

    const result = await worker.process(linkJob);

    expect(attemptAutoDebit).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith('s1', 4);
    expect(result).toMatchObject({ scheduleId: 's1', status: 'sent' });
  });

  it('onModuleInit is a no-op when workers are disabled (no Worker constructed)', () => {
    const worker = new RetryWorker(
      { attemptAutoDebit: vi.fn() } as never,
      { dispatch: vi.fn() } as never,
      makeConfig(),
      makeLogger(),
    );
    expect(() => worker.onModuleInit()).not.toThrow();
  });
});
