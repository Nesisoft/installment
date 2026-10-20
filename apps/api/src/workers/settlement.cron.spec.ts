import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { PinoLogger } from 'nestjs-pino';
import { SettlementCron } from './settlement.cron';
import type { Env } from '../config/env.validation';
import * as alerting from '../common/alerting';

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

  /**
   * A payout that did not go out has to be heard about.
   *
   * Checked against Paystack test mode (2026-10-20): on this account every
   * transfer is refused with 400 "You cannot initiate third party payouts as a
   * starter business". The run parks each as `unknown`, reconciliation reverses
   * it, and the cron only ever logged counts — so no merchant would be paid,
   * every night, and nothing would say so.
   */
  describe('payouts that did not go out', () => {
    beforeEach(() => vi.restoreAllMocks());
    const STARTER = 'You cannot initiate third party payouts as a starter business';

    function cronFor(results: unknown[]) {
      const run = vi.fn(async () => ({ asOfDate: '2026-10-20', totalSettledPesewas: 0, results }));
      return new SettlementCron(
        { runDailySettlement: run } as never,
        makeConfig(true),
        makeLogger(),
      );
    }

    it('warns, grouped by reason, when some payouts did not go out', async () => {
      const captureAlert = vi.spyOn(alerting, 'captureAlert').mockImplementation(() => {});
      await cronFor([
        { merchantId: 'a', status: 'settled', amountPesewas: 10_000 },
        { merchantId: 'b', status: 'unknown', amountPesewas: 20_000, reason: STARTER },
        { merchantId: 'c', status: 'unknown', amountPesewas: 5_000, reason: STARTER },
        { merchantId: 'd', status: 'failed', amountPesewas: 7_000, reason: 'transfer failed' },
      ]).run();

      expect(captureAlert).toHaveBeenCalledOnce();
      const [message, level, extra] = captureAlert.mock.calls[0]!;
      expect(message).toMatch(/3 merchant payouts did not go out/);
      expect(level).toBe('warning');
      expect(extra).toMatchObject({
        asOfDate: '2026-10-20',
        reasons: [
          { reason: STARTER, payouts: 2, pesewas: 25_000 },
          { reason: 'transfer failed', payouts: 1, pesewas: 7_000 },
        ],
      });
    });

    it('raises an error when not one payout went out', async () => {
      // Every attempt refused for the same reason is an account or configuration
      // problem, not a merchant's bad account number.
      const captureAlert = vi.spyOn(alerting, 'captureAlert').mockImplementation(() => {});
      await cronFor([
        { merchantId: 'b', status: 'unknown', amountPesewas: 20_000, reason: STARTER },
        { merchantId: 'c', status: 'unknown', amountPesewas: 5_000, reason: STARTER },
        { merchantId: 'e', status: 'skipped', amountPesewas: 0, reason: 'below floor' },
      ]).run();

      const [message, level] = captureAlert.mock.calls[0]!;
      expect(level).toBe('error');
      expect(message).toMatch(/no merchant payout went out/i);
      expect(message).toContain(STARTER);
    });

    it('stays silent when every payout settled, waited on confirmation, or was skipped', async () => {
      const captureAlert = vi.spyOn(alerting, 'captureAlert').mockImplementation(() => {});
      await cronFor([
        { merchantId: 'a', status: 'settled', amountPesewas: 10_000 },
        { merchantId: 'b', status: 'pending_confirmation', amountPesewas: 3_000 },
        { merchantId: 'c', status: 'skipped', amountPesewas: 0, reason: 'no balance' },
      ]).run();
      expect(captureAlert).not.toHaveBeenCalled();
    });
  });
});
