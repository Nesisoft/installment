import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { PinoLogger } from 'nestjs-pino';
import { OrderExpiryCron } from './order-expiry.cron';
import type { Env } from '../config/env.validation';

function makeConfig(enabled: boolean, ttlHours = 24): ConfigService<Env, true> {
  return {
    get: vi.fn((key: string) => (key === 'ENABLE_SCHEDULED_WORKERS' ? enabled : ttlHours)),
  } as unknown as ConfigService<Env, true>;
}
function makeLogger(): PinoLogger {
  return { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as unknown as PinoLogger;
}

describe('OrderExpiryCron', () => {
  it('sweeps with the configured TTL and logs what it released', async () => {
    const sweepAbandoned = vi.fn(async () => ({
      checked: 4,
      cancelled: 4,
      releasedUnits: 9,
      failed: 0,
    }));
    const logger = makeLogger();
    const cron = new OrderExpiryCron({ sweepAbandoned } as never, makeConfig(true, 48), logger);

    await cron.run();

    expect(sweepAbandoned).toHaveBeenCalledOnce();
    expect(sweepAbandoned.mock.calls[0]![1]).toEqual({ paymentTtlHours: 48 });
    const [meta] = (logger.info as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(meta).toMatchObject({ cancelled: 4, releasedUnits: 9, ttlHours: 48 });
  });

  it('stays quiet when there was nothing to sweep', async () => {
    // An hourly worker that logs on every run is one nobody reads.
    const sweepAbandoned = vi.fn(async () => ({
      checked: 0,
      cancelled: 0,
      releasedUnits: 0,
      failed: 0,
    }));
    const logger = makeLogger();
    const cron = new OrderExpiryCron({ sweepAbandoned } as never, makeConfig(true), logger);

    await cron.run();

    expect(sweepAbandoned).toHaveBeenCalledOnce();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('warns, but does not error, when orders moved between select and cancel', async () => {
    const sweepAbandoned = vi.fn(async () => ({
      checked: 3,
      cancelled: 2,
      releasedUnits: 2,
      failed: 1,
    }));
    const logger = makeLogger();
    const cron = new OrderExpiryCron({ sweepAbandoned } as never, makeConfig(true), logger);

    await cron.run();

    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('does nothing when scheduled workers are disabled', async () => {
    const sweepAbandoned = vi.fn();
    const cron = new OrderExpiryCron({ sweepAbandoned } as never, makeConfig(false), makeLogger());

    await cron.run();

    expect(sweepAbandoned).not.toHaveBeenCalled();
  });

  it('never lets a sweep failure escape the scheduler', async () => {
    const sweepAbandoned = vi.fn(async () => {
      throw new Error('db gone');
    });
    const logger = makeLogger();
    const cron = new OrderExpiryCron({ sweepAbandoned } as never, makeConfig(true), logger);

    await expect(cron.run()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledOnce();
  });
});
