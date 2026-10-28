import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { PinoLogger } from 'nestjs-pino';
import { ReserveReleaseCron } from './reserve-release.cron';
import * as alerting from '../common/alerting';
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

  it('alerts with each failed release, its plan, merchant and error', async () => {
    const capture = vi.spyOn(alerting, 'captureAlert').mockImplementation(() => {});
    const summary = {
      asOf: '2026-10-01T07:00:00.000Z',
      merchantsChecked: 2,
      totalReleasedPesewas: 0,
      failedReleases: 2,
      perMerchant: [
        {
          merchantId: 'm1',
          totalReleasedPesewas: 0,
          releases: [],
          failures: [{ heldReserveId: 'hr1', customerPlanId: 'p1', error: 'lock timeout' }],
        },
        {
          merchantId: 'm2',
          totalReleasedPesewas: 0,
          releases: [],
          // The sweep could not read this merchant's reserves at all.
          failures: [{ heldReserveId: '', customerPlanId: '', error: 'connection reset' }],
        },
      ],
    };
    const cron = new ReserveReleaseCron(
      { runSweep: vi.fn(async () => summary) } as never,
      makeConfig(true),
      makeLogger(),
    );

    await cron.run();

    expect(capture).toHaveBeenCalledWith('reserve releases could not be booked', 'error', {
      failedReleases: 2,
      failures: [
        { merchantId: 'm1', heldReserveId: 'hr1', customerPlanId: 'p1', error: 'lock timeout' },
        { merchantId: 'm2', heldReserveId: '', customerPlanId: '', error: 'connection reset' },
      ],
    });
    capture.mockRestore();
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
