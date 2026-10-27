import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { PinoLogger } from 'nestjs-pino';
import { SellersOwingReport, type SellerOwingRow } from '@installment/core';
import { SellersOwingAlertCron } from './sellers-owing-alert.cron';
import type { Env } from '../config/env.validation';
import * as alerting from '../common/alerting';

function config(threshold: number, enabled = true): ConfigService<Env, true> {
  return {
    get: vi.fn((key: string) => (key === 'SELLERS_OWING_ALERT_PESEWAS' ? threshold : enabled)),
  } as unknown as ConfigService<Env, true>;
}
const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) as unknown as PinoLogger;

const row = (over: Partial<SellerOwingRow> = {}): SellerOwingRow => ({
  merchant_id: 'm1',
  business_name: 'Kofi Electronics',
  status: 'active',
  owed_pesewas: 12_000,
  unrecoverable: false,
  seller_age_days: 12,
  returns_90d_pesewas: 30_000,
  returns_90d_count: 2,
  last_payout_at: null,
  last_payout_pesewas: null,
  ...over,
});

function cron(rows: SellerOwingRow[], threshold = 500_000, enabled = true) {
  // The real summariser over stub rows: the arithmetic is the report's own.
  const real = new SellersOwingReport({} as never);
  const report = { list: vi.fn(async () => rows), summarise: real.summarise.bind(real) };
  return new SellersOwingAlertCron(report as never, config(threshold, enabled), logger());
}

describe('SellersOwingAlertCron', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('pages, as an error, for a seller who owes and can no longer be paid out', async () => {
    const capture = vi.spyOn(alerting, 'captureAlert').mockImplementation(() => {});
    await cron([row({ status: 'offboarded', unrecoverable: true, owed_pesewas: 45_000 })]).run();
    expect(capture).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledWith(
      expect.stringContaining('1 seller who can no longer be paid out owes GHS 450.00'),
      'error',
      expect.objectContaining({
        sellers: [expect.objectContaining({ business_name: 'Kofi Electronics' })],
      }),
    );
  });

  it('warns once the total owed reaches the threshold', async () => {
    const capture = vi.spyOn(alerting, 'captureAlert').mockImplementation(() => {});
    await cron([
      row({ owed_pesewas: 300_000 }),
      row({ merchant_id: 'm2', owed_pesewas: 250_000 }),
    ]).run();
    expect(capture).toHaveBeenCalledWith(
      expect.stringContaining('2 sellers owe GHS 5,500.00 in total'),
      'warning',
      expect.anything(),
    );
  });

  it('stays quiet under the threshold when every seller can still be netted off', async () => {
    const capture = vi.spyOn(alerting, 'captureAlert').mockImplementation(() => {});
    await cron([row({ owed_pesewas: 12_000 })]).run();
    expect(capture).not.toHaveBeenCalled();
  });

  it('does nothing when no seller owes, or when workers are off', async () => {
    const capture = vi.spyOn(alerting, 'captureAlert').mockImplementation(() => {});
    await cron([]).run();
    await cron([row({ unrecoverable: true })], 0, false).run();
    expect(capture).not.toHaveBeenCalled();
  });
});
