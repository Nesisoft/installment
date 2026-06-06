import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { PinoLogger } from 'nestjs-pino';
import { ReserveReleaseCron } from './reserve-release.cron';
import type { Env } from '../config/env.validation';

function makeConfig(enabled: boolean): ConfigService<Env, true> {
  return { get: vi.fn(() => enabled) } as unknown as ConfigService<Env, true>;
}
function makeLogger(): PinoLogger {
  return { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as unknown as PinoLogger;
}

describe('ReserveReleaseCron', () => {
  it('runs the sweep and logs the rollup when enabled', async () => {
    const summary = {
      asOf: '2026-10-01T07:00:00.000Z',
      merchantsChecked: 3,
      totalReleasedPesewas: 8_000,
      perMerchant: [
        { merchantId: 'a', totalReleasedPesewas: 5_000, releases: [] },
        { merchantId: 'b', totalReleasedPesewas: 3_000, releases: [] },
        { merchantId: 'c', totalReleasedPesewas: 0, releases: [] },
      ],
    };
    const runSweep = vi.fn(async () => summary);
    const logger = makeLogger();
    const cron = new ReserveReleaseCron({ runSweep } as never, makeConfig(true), logger);

    await cron.run();

    expect(runSweep).toHaveBeenCalledOnce();
    const [meta] = (logger.info as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(meta).toMatchObject({
      merchantsChecked: 3,
      totalReleasedPesewas: 8_000,
      merchantsWithRelease: 2,
    });
  });

  it('is a no-op when ENABLE_SCHEDULED_WORKERS is false', async () => {
    const runSweep = vi.fn();
    const cron = new ReserveReleaseCron({ runSweep } as never, makeConfig(false), makeLogger());
    await cron.run();
    expect(runSweep).not.toHaveBeenCalled();
  });

  it('swallows errors and logs them', async () => {
    const runSweep = vi.fn(async () => {
      throw new Error('redis down');
    });
    const logger = makeLogger();
    const cron = new ReserveReleaseCron({ runSweep } as never, makeConfig(true), logger);
    await expect(cron.run()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledOnce();
  });
});
