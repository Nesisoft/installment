import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { PinoLogger } from 'nestjs-pino';
import { DebitSchedulerCron } from './debit-scheduler.cron';
import type { Env } from '../config/env.validation';

function makeConfig(enabled: boolean): ConfigService<Env, true> {
  return { get: vi.fn(() => enabled) } as unknown as ConfigService<Env, true>;
}
function makeLogger(): PinoLogger {
  return { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as unknown as PinoLogger;
}

describe('DebitSchedulerCron', () => {
  it('sweeps and logs the rollup when enabled and work was done', async () => {
    const summary = {
      asOfDate: '2026-10-15',
      attempted: 2,
      succeeded: 1,
      pending: 1,
      failed: 0,
      unknown: 0,
      skipped: 0,
      outcomes: [],
    };
    const sweepDue = vi.fn(async () => summary);
    const logger = makeLogger();
    const cron = new DebitSchedulerCron({ sweepDue } as never, makeConfig(true), logger);

    await cron.run();

    expect(sweepDue).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledOnce();
    const [meta] = (logger.info as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(meta).toMatchObject({ attempted: 2, succeeded: 1, pending: 1 });
  });

  it('stays quiet when nothing was due', async () => {
    const sweepDue = vi.fn(async () => ({
      asOfDate: '2026-10-15',
      attempted: 0,
      succeeded: 0,
      pending: 0,
      failed: 0,
      unknown: 0,
      skipped: 0,
      outcomes: [],
    }));
    const logger = makeLogger();
    const cron = new DebitSchedulerCron({ sweepDue } as never, makeConfig(true), logger);
    await cron.run();
    expect(sweepDue).toHaveBeenCalledOnce();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('is a no-op when ENABLE_SCHEDULED_WORKERS is false', async () => {
    const sweepDue = vi.fn();
    const cron = new DebitSchedulerCron({ sweepDue } as never, makeConfig(false), makeLogger());
    await cron.run();
    expect(sweepDue).not.toHaveBeenCalled();
  });

  it('swallows errors and logs them', async () => {
    const sweepDue = vi.fn(async () => {
      throw new Error('db down');
    });
    const logger = makeLogger();
    const cron = new DebitSchedulerCron({ sweepDue } as never, makeConfig(true), logger);
    await expect(cron.run()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledOnce();
  });
});
