import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { LateFeeCron } from './late-fee.cron';
import * as alerting from '../common/alerting';
import type { Env } from '../config/env.validation';

function makeConfig(enabled: boolean): ConfigService<Env, true> {
  return { get: vi.fn(() => enabled) } as unknown as ConfigService<Env, true>;
}

describe('LateFeeCron', () => {
  it('does nothing when scheduled workers are switched off', async () => {
    const accrue = vi.fn(async () => []);
    const cron = new LateFeeCron({ accrue } as never, makeConfig(false));

    await cron.run();

    expect(accrue).not.toHaveBeenCalled();
  });

  it('accrues when scheduled workers are on', async () => {
    const accrue = vi.fn(async () => [
      { feePesewas: 1_500, previousFeePesewas: 1_000, capped: false },
    ]);
    const cron = new LateFeeCron({ accrue } as never, makeConfig(true));

    await cron.run();

    expect(accrue).toHaveBeenCalledOnce();
  });

  it('reports a failed sweep instead of throwing', async () => {
    const capture = vi.spyOn(alerting, 'captureWorkerError').mockImplementation(() => {});
    const accrue = vi.fn(async () => {
      throw new Error('db down');
    });
    const cron = new LateFeeCron({ accrue } as never, makeConfig(true));

    await expect(cron.run()).resolves.toBeUndefined();
    expect(capture).toHaveBeenCalledWith(expect.any(Error), 'late-fee-accrual');
    capture.mockRestore();
  });
});
