import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { ReturnWindowCron } from './return-window.cron';
import * as alerting from '../common/alerting';
import type { Env } from '../config/env.validation';

function makeConfig(enabled: boolean): ConfigService<Env, true> {
  return { get: vi.fn(() => enabled) } as unknown as ConfigService<Env, true>;
}

describe('ReturnWindowCron', () => {
  it('does nothing when scheduled workers are switched off', async () => {
    const completeElapsedReturnWindows = vi.fn(async () => []);
    const cron = new ReturnWindowCron({ completeElapsedReturnWindows } as never, makeConfig(false));

    await cron.run();

    expect(completeElapsedReturnWindows).not.toHaveBeenCalled();
  });

  it('closes elapsed windows as the system when scheduled workers are on', async () => {
    const completeElapsedReturnWindows = vi.fn(async () => ['order-1']);
    const cron = new ReturnWindowCron({ completeElapsedReturnWindows } as never, makeConfig(true));

    await cron.run();

    expect(completeElapsedReturnWindows).toHaveBeenCalledOnce();
    expect(completeElapsedReturnWindows).toHaveBeenCalledWith(
      expect.objectContaining({ actorType: 'system' }),
    );
  });

  it('reports a failed sweep instead of throwing', async () => {
    const capture = vi.spyOn(alerting, 'captureWorkerError').mockImplementation(() => {});
    const completeElapsedReturnWindows = vi.fn(async () => {
      throw new Error('db down');
    });
    const cron = new ReturnWindowCron({ completeElapsedReturnWindows } as never, makeConfig(true));

    await expect(cron.run()).resolves.toBeUndefined();
    expect(capture).toHaveBeenCalledWith(expect.any(Error), 'return-window-close');
    capture.mockRestore();
  });
});
