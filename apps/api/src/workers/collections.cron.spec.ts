import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { PinoLogger } from 'nestjs-pino';
import { CollectionsCron } from './collections.cron';
import type { Env } from '../config/env.validation';

function makeConfig(enabled: boolean): ConfigService<Env, true> {
  return { get: vi.fn(() => enabled) } as unknown as ConfigService<Env, true>;
}
function makeLogger(): PinoLogger {
  return { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as unknown as PinoLogger;
}

describe('CollectionsCron', () => {
  it('runs the sweep and logs when something moved', async () => {
    const runSweep = vi.fn(async () => ({
      graceExpired: 2,
      casesOpened: 1,
      stagesAdvanced: 3,
      writtenOff: 1,
      advances: [],
    }));
    const logger = makeLogger();
    const cron = new CollectionsCron({ runSweep } as never, makeConfig(true), logger);

    await cron.run();

    expect(runSweep).toHaveBeenCalledOnce();
    const [meta] = (logger.info as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(meta).toMatchObject({
      graceExpired: 2,
      casesOpened: 1,
      stagesAdvanced: 3,
      writtenOff: 1,
    });
  });

  it('stays quiet when nothing moved', async () => {
    const runSweep = vi.fn(async () => ({
      graceExpired: 0,
      casesOpened: 0,
      stagesAdvanced: 0,
      writtenOff: 0,
      advances: [],
    }));
    const logger = makeLogger();
    const cron = new CollectionsCron({ runSweep } as never, makeConfig(true), logger);
    await cron.run();
    expect(runSweep).toHaveBeenCalledOnce();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('is a no-op when ENABLE_SCHEDULED_WORKERS is false', async () => {
    const runSweep = vi.fn();
    const cron = new CollectionsCron({ runSweep } as never, makeConfig(false), makeLogger());
    await cron.run();
    expect(runSweep).not.toHaveBeenCalled();
  });

  it('swallows errors and logs them', async () => {
    const runSweep = vi.fn(async () => {
      throw new Error('db down');
    });
    const logger = makeLogger();
    const cron = new CollectionsCron({ runSweep } as never, makeConfig(true), logger);
    await expect(cron.run()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledOnce();
  });
});
