import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OpsSnapshot } from '@installment/core';
import { OpsMetricsCollector } from './ops-metrics.collector';
import { metricsRegistry } from './metrics';

const SNAPSHOT: OpsSnapshot = {
  schedules: { due: 4, processing: 2, retry_scheduled: 1, overdue: 3, in_collections: 5 },
  stuckProcessing: 1,
  payoutsInFlight: { initiated: 0, pending_confirmation: 2, unknown: 1 },
  latestPayoutDay: { asOfDate: '2026-10-28', byStatus: { settled: 7, failed: 1 } },
  refunds: [
    { queue: 'to_send', count: 1, amount_pesewas: 5_000, oldest_requested_at: null },
    { queue: 'unresolved', count: 2, amount_pesewas: 12_500, oldest_requested_at: null },
  ],
  collectionsOpen: { soft_reminder: 3, legal_threat: 1 },
  sellersOwing: { count: 2, pesewas: 34_000 },
};

describe('OpsMetricsCollector', () => {
  const snapshot = vi.fn(async () => SNAPSHOT);
  const telco = {
    snapshot: vi.fn(async () => [
      { telco: 'mtn', status: 'healthy', successRate: 0.95, attempts: 40 },
      { telco: 'vod', status: 'down', successRate: 0.2, attempts: 20 },
      { telco: 'tgo', status: 'unknown', successRate: null, attempts: 2 },
    ]),
  };
  const collector = new OpsMetricsCollector({ snapshot } as never, telco as never);

  beforeAll(() => collector.onModuleInit());
  afterAll(() => vi.restoreAllMocks());

  it('publishes the backlog the runbooks act on', async () => {
    const text = await metricsRegistry.metrics();
    for (const line of [
      'installment_ops_metrics_up 1',
      'installment_schedules_open{status="in_collections"} 5',
      'installment_schedules_stuck_processing 1',
      'installment_payouts_in_flight{status="unknown"} 1',
      'installment_payouts_latest_day{status="failed"} 1',
      'installment_payouts_latest_day_timestamp_seconds 1793145600',
      'installment_refunds{queue="unresolved"} 2',
      'installment_refunds_pesewas{queue="unresolved"} 12500',
      'installment_collections_cases_open{stage="legal_threat"} 1',
      'installment_sellers_owing 2',
      'installment_sellers_owing_pesewas 34000',
      'installment_telco_status{telco="vod"} 2',
      'installment_telco_status{telco="tgo"} -1',
      'installment_telco_success_ratio{telco="mtn"} 0.95',
    ]) {
      expect(text, line).toContain(line);
    }
    // No success rate is published for a network with too few attempts to judge.
    expect(text).not.toContain('installment_telco_success_ratio{telco="tgo"}');
  });

  it('reads the database once per scrape, however many gauges ask', async () => {
    snapshot.mockClear();
    await metricsRegistry.metrics();
    expect(snapshot.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('says so when the backlog cannot be read, rather than reporting no work', async () => {
    const failing = new OpsMetricsCollector(
      { snapshot: vi.fn(async () => Promise.reject(new Error('db down'))) } as never,
      telco as never,
    );
    // Swap the shared collector's source for one scrape.
    const original = collector.snapshot.bind(collector);
    vi.spyOn(collector, 'snapshot').mockImplementation(() => failing.snapshot());
    const text = await metricsRegistry.metrics();
    expect(text).toContain('installment_ops_metrics_up 0');
    // The last good values stay rather than dropping to zero.
    expect(text).toContain('installment_sellers_owing 2');
    vi.mocked(collector.snapshot).mockImplementation(original);
  });
});
