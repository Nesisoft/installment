import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { PinoLogger } from 'nestjs-pino';
import { SettlementCron } from './settlement.cron';
import type { Env } from '../config/env.validation';

function makeConfig(enabled: boolean): ConfigService<Env, true> {
  return { get: vi.fn(() => enabled) } as unknown as ConfigService<Env, true>;
}
function makeLogger(): PinoLogger {
  return { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as unknown as PinoLogger;
}

describe('SettlementCron', () => {
  it('calls the daily settlement runner and logs the rollup when enabled', async () => {
    const summary = {
      asOfDate: '2026-10-01',
      totalSettledPesewas: 91_000,
      results: [
        { merchantId: 'a', status: 'settled' as const, amountPesewas: 91_000 },
        { merchantId: 'b', status: 'skipped' as const, amountPesewas: 0, reason: 'no balance' },
      ],
    };
    const run = vi.fn(async () => summary);
    const logger = makeLogger();
    const cron = new SettlementCron({ runDailySettlement: run } as never, makeConfig(true), logger);

    await cron.run();

    expect(run).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledOnce();
    const [meta] = (logger.info as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(meta).toMatchObject({
      asOfDate: '2026-10-01',
      merchantsChecked: 2,
      totalSettledPesewas: 91_000,
      settled: 1,
      skipped: 1,
    });
  });

  it('is a no-op when ENABLE_SCHEDULED_WORKERS is false', async () => {
    const run = vi.fn();
    const cron = new SettlementCron(
      { runDailySettlement: run } as never,
      makeConfig(false),
      makeLogger(),
    );
    await cron.run();
    expect(run).not.toHaveBeenCalled();
  });

  it('swallows errors and logs them — the next tick retries', async () => {
    const run = vi.fn(async () => {
      throw new Error('db down');
    });
    const logger = makeLogger();
    const cron = new SettlementCron({ runDailySettlement: run } as never, makeConfig(true), logger);

    await expect(cron.run()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledOnce();
  });
});
