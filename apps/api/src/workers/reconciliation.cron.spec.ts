import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { PinoLogger } from 'nestjs-pino';
import { ReconciliationCron } from './reconciliation.cron';
import type { Env } from '../config/env.validation';

function makeConfig(enabled: boolean): ConfigService<Env, true> {
  return { get: vi.fn(() => enabled) } as unknown as ConfigService<Env, true>;
}
function makeLogger(): PinoLogger {
  return { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as unknown as PinoLogger;
}

describe('ReconciliationCron', () => {
  it('runs the sweep with the batch limit and logs when work was done', async () => {
    const summary = {
      checked: 5,
      settled: 3,
      failed: 1,
      stillPending: 1,
      unresolved: 0,
      results: [],
    };
    const reconcilePendingPayouts = vi.fn(async () => summary);
    const logger = makeLogger();
    const cron = new ReconciliationCron(
      { reconcilePendingPayouts } as never,
      makeConfig(true),
      logger,
    );

    await cron.run();

    expect(reconcilePendingPayouts).toHaveBeenCalledWith({ limit: 100 });
    expect(logger.info).toHaveBeenCalledOnce();
  });

  it('stays quiet when nothing needed reconciling', async () => {
    const summary = {
      checked: 0,
      settled: 0,
      failed: 0,
      stillPending: 0,
      unresolved: 0,
      results: [],
    };
    const reconcilePendingPayouts = vi.fn(async () => summary);
    const logger = makeLogger();
    const cron = new ReconciliationCron(
      { reconcilePendingPayouts } as never,
      makeConfig(true),
      logger,
    );
    await cron.run();
    expect(reconcilePendingPayouts).toHaveBeenCalledOnce();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('is a no-op when ENABLE_SCHEDULED_WORKERS is false', async () => {
    const reconcilePendingPayouts = vi.fn();
    const cron = new ReconciliationCron(
      { reconcilePendingPayouts } as never,
      makeConfig(false),
      makeLogger(),
    );
    await cron.run();
    expect(reconcilePendingPayouts).not.toHaveBeenCalled();
  });

  it('swallows errors and logs them', async () => {
    const reconcilePendingPayouts = vi.fn(async () => {
      throw new Error('paystack timeout');
    });
    const logger = makeLogger();
    const cron = new ReconciliationCron(
      { reconcilePendingPayouts } as never,
      makeConfig(true),
      logger,
    );
    await expect(cron.run()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledOnce();
  });
});
