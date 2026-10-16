import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { PinoLogger } from 'nestjs-pino';
import { DeclineReasonAlertCron } from './decline-reason-alert.cron';
import type { Env } from '../config/env.validation';
import * as alerting from '../common/alerting';

function makeConfig(enabled: boolean): ConfigService<Env, true> {
  return { get: vi.fn(() => enabled) } as unknown as ConfigService<Env, true>;
}
function makeLogger(): PinoLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as PinoLogger;
}

const PROSE = {
  reason: 'Insufficient Funds',
  attempts: 12,
  last_seen_at: '2026-10-16 09:00:00+00',
  classified_as: 'ambiguous',
  source: 'unrecognised',
};

describe('DeclineReasonAlertCron', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('raises one alert naming every reason the map does not know, with counts', async () => {
    const captureAlert = vi.spyOn(alerting, 'captureAlert').mockImplementation(() => {});
    const unrecognised = vi.fn(async () => [PROSE, { ...PROSE, reason: 'Declined', attempts: 3 }]);
    const cron = new DeclineReasonAlertCron(
      { unrecognised } as never,
      makeConfig(true),
      makeLogger(),
    );

    await cron.run();

    // One alert for the batch, not one per decline: if every real decline is
    // prose, a per-decline alert would page on every failed charge.
    expect(captureAlert).toHaveBeenCalledOnce();
    expect(captureAlert).toHaveBeenCalledWith(
      expect.stringContaining('2 Paystack decline reasons'),
      'warning',
      expect.objectContaining({
        reasons: [
          { reason: 'Insufficient Funds', attempts: 12 },
          { reason: 'Declined', attempts: 3 },
        ],
      }),
    );
  });

  it('looks back one day', async () => {
    vi.spyOn(alerting, 'captureAlert').mockImplementation(() => {});
    const unrecognised = vi.fn(async (_opts: { since: Date }) => []);
    const now = new Date('2026-10-16T08:00:00Z');
    const cron = new DeclineReasonAlertCron(
      { unrecognised } as never,
      makeConfig(true),
      makeLogger(),
    );

    await cron.run(now);

    expect(unrecognised.mock.calls[0]![0].since.toISOString()).toBe('2026-10-15T08:00:00.000Z');
  });

  it('stays silent when every decline reason was recognised', async () => {
    const captureAlert = vi.spyOn(alerting, 'captureAlert').mockImplementation(() => {});
    const unrecognised = vi.fn(async () => []);
    const cron = new DeclineReasonAlertCron(
      { unrecognised } as never,
      makeConfig(true),
      makeLogger(),
    );
    await cron.run();
    expect(captureAlert).not.toHaveBeenCalled();
  });

  it('is a no-op when ENABLE_SCHEDULED_WORKERS is false', async () => {
    const unrecognised = vi.fn();
    const cron = new DeclineReasonAlertCron(
      { unrecognised } as never,
      makeConfig(false),
      makeLogger(),
    );
    await cron.run();
    expect(unrecognised).not.toHaveBeenCalled();
  });

  it('swallows errors and logs them', async () => {
    const unrecognised = vi.fn(async () => {
      throw new Error('db down');
    });
    const logger = makeLogger();
    const cron = new DeclineReasonAlertCron({ unrecognised } as never, makeConfig(true), logger);
    await expect(cron.run()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledOnce();
  });
});
