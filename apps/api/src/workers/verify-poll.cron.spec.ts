import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { PinoLogger } from 'nestjs-pino';
import { VerifyPollCron } from './verify-poll.cron';
import type { Env } from '../config/env.validation';

function makeConfig(enabled: boolean): ConfigService<Env, true> {
  return { get: vi.fn(() => enabled) } as unknown as ConfigService<Env, true>;
}
function makeLogger(): PinoLogger {
  return { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as unknown as PinoLogger;
}

const emptySummary = {
  checked: 0,
  succeeded: 0,
  failed: 0,
  pending: 0,
  unknown: 0,
  skipped: 0,
  outcomes: [],
};

describe('VerifyPollCron', () => {
  it('sweeps with a stale cutoff in the past and logs when attempts were checked', async () => {
    const sweepStale = vi.fn(async () => ({
      ...emptySummary,
      checked: 3,
      succeeded: 2,
      failed: 1,
    }));
    const logger = makeLogger();
    const cron = new VerifyPollCron({ sweepStale } as never, makeConfig(true), logger);

    const before = Date.now();
    await cron.run();

    expect(sweepStale).toHaveBeenCalledOnce();
    const [staleBefore, actor] = (sweepStale as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(staleBefore.getTime()).toBeLessThan(before); // cutoff is in the past
    expect(actor).toMatchObject({ actorType: 'system' });
    expect(logger.info).toHaveBeenCalledOnce();
  });

  it('stays quiet when nothing was stale', async () => {
    const sweepStale = vi.fn(async () => emptySummary);
    const logger = makeLogger();
    const cron = new VerifyPollCron({ sweepStale } as never, makeConfig(true), logger);
    await cron.run();
    expect(sweepStale).toHaveBeenCalledOnce();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('is a no-op when ENABLE_SCHEDULED_WORKERS is false', async () => {
    const sweepStale = vi.fn();
    const cron = new VerifyPollCron({ sweepStale } as never, makeConfig(false), makeLogger());
    await cron.run();
    expect(sweepStale).not.toHaveBeenCalled();
  });

  it('swallows errors and logs them', async () => {
    const sweepStale = vi.fn(async () => {
      throw new Error('paystack down');
    });
    const logger = makeLogger();
    const cron = new VerifyPollCron({ sweepStale } as never, makeConfig(true), logger);
    await expect(cron.run()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledOnce();
  });
});
