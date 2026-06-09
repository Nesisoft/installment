import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { PinoLogger } from 'nestjs-pino';
import { TelcoAlertCron } from './telco-alert.cron';
import type { Env } from '../config/env.validation';
import * as alerting from '../common/alerting';

function makeConfig(enabled: boolean): ConfigService<Env, true> {
  return { get: vi.fn(() => enabled) } as unknown as ConfigService<Env, true>;
}
function makeLogger(): PinoLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as PinoLogger;
}

describe('TelcoAlertCron', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('raises a Sentry alert for each degraded/down telco', async () => {
    const captureAlert = vi.spyOn(alerting, 'captureAlert').mockImplementation(() => {});
    const snapshot = vi.fn(async () => [
      { telco: 'mtn', status: 'healthy', successRate: 0.95, attempts: 40 },
      { telco: 'tgo', status: 'degraded', successRate: 0.5, attempts: 20 },
      { telco: 'vod', status: 'down', successRate: 0.1, attempts: 15 },
    ]);
    const cron = new TelcoAlertCron({ snapshot } as never, makeConfig(true), makeLogger());

    await cron.run();

    expect(snapshot).toHaveBeenCalledOnce();
    expect(captureAlert).toHaveBeenCalledTimes(2);
    expect(captureAlert).toHaveBeenCalledWith(
      'MoMo telco TGO is degraded',
      'warning',
      expect.objectContaining({ telco: 'tgo' }),
    );
    expect(captureAlert).toHaveBeenCalledWith(
      'MoMo telco VOD is down',
      'error',
      expect.objectContaining({ telco: 'vod' }),
    );
  });

  it('stays silent when every telco is healthy/unknown', async () => {
    const captureAlert = vi.spyOn(alerting, 'captureAlert').mockImplementation(() => {});
    const snapshot = vi.fn(async () => [
      { telco: 'mtn', status: 'healthy', successRate: 0.95, attempts: 40 },
      { telco: 'tgo', status: 'unknown', successRate: null, attempts: 3 },
      { telco: 'vod', status: 'healthy', successRate: 0.99, attempts: 50 },
    ]);
    const cron = new TelcoAlertCron({ snapshot } as never, makeConfig(true), makeLogger());
    await cron.run();
    expect(captureAlert).not.toHaveBeenCalled();
  });

  it('is a no-op when ENABLE_SCHEDULED_WORKERS is false', async () => {
    const snapshot = vi.fn();
    const cron = new TelcoAlertCron({ snapshot } as never, makeConfig(false), makeLogger());
    await cron.run();
    expect(snapshot).not.toHaveBeenCalled();
  });

  it('swallows errors and logs them', async () => {
    const snapshot = vi.fn(async () => {
      throw new Error('redis down');
    });
    const logger = makeLogger();
    const cron = new TelcoAlertCron({ snapshot } as never, makeConfig(true), logger);
    await expect(cron.run()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledOnce();
  });
});
