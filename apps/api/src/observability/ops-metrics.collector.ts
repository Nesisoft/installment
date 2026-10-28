import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { Gauge } from '@prometheus-io/client';
import { OpsMetricsService, TelcoHealthMonitor, type OpsSnapshot } from '@installment/core';
import { metricsRegistry } from './metrics';

/** A scrape every 15–30 seconds should not mean seven queries every 15–30 seconds each. */
const SNAPSHOT_TTL_MS = 15_000;

const TELCO_STATUS_VALUE: Record<string, number> = {
  healthy: 0,
  degraded: 1,
  down: 2,
  unknown: -1,
};

/**
 * Publishes the operational backlog as gauges, read when Prometheus scrapes.
 *
 * Each gauge is something a runbook acts on (docs/runbooks): instalments stuck
 * mid-charge, payouts with no answer, refunds waiting on a person, collections
 * cases by stage, sellers who owe money, Mobile Money networks failing. Sentry
 * says when one of these happens; these say how many there are, so a level that
 * never falls is visible too.
 *
 * Every gauge reads one shared snapshot, cached for {@link SNAPSHOT_TTL_MS}. If
 * reading it fails, `installment_ops_metrics_up` goes to 0 and the other gauges
 * keep their last values rather than reporting zero work.
 */
@Injectable()
export class OpsMetricsCollector implements OnModuleInit {
  private cached: { at: number; value: Promise<OpsSnapshot> } | null = null;

  constructor(
    @Inject(OpsMetricsService) private readonly ops: OpsMetricsService,
    @Inject(TelcoHealthMonitor) private readonly telco: TelcoHealthMonitor,
  ) {}

  onModuleInit(): void {
    // Registered once per registry: a second app in the same process (the
    // specs build several) reuses the gauges already there.
    if (metricsRegistry.getSingleMetric('installment_ops_metrics_up')) return;
    this.register();
  }

  /** The current snapshot, shared by every gauge in one scrape. */
  snapshot(now = Date.now()): Promise<OpsSnapshot> {
    if (!this.cached || now - this.cached.at > SNAPSHOT_TTL_MS) {
      const value = this.ops.snapshot(new Date(now));
      this.cached = { at: now, value };
      // A failed read is not kept: the next scrape tries again.
      value.catch(() => {
        if (this.cached?.value === value) this.cached = null;
      });
    }
    return this.cached.value;
  }

  private register(): void {
    const registers = [metricsRegistry];
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const collector = this;
    // Reads the snapshot itself: the registry serialises gauges in order, so
    // one that only other gauges updated would report the previous scrape.
    new Gauge({
      name: 'installment_ops_metrics_up',
      help: '1 when the operational gauges below were read at this scrape, 0 when reading them failed.',
      registers,
      async collect() {
        try {
          await collector.snapshot();
          this.set(1);
        } catch {
          this.set(0);
        }
      },
    });

    /** A gauge whose value comes from the snapshot. */
    const fromSnapshot = <L extends string>(
      name: string,
      help: string,
      labelNames: readonly L[],
      apply: (gauge: Gauge<L>, s: OpsSnapshot) => void,
    ) =>
      new Gauge<L>({
        name,
        help,
        labelNames,
        registers,
        async collect() {
          let s: OpsSnapshot;
          try {
            s = await collector.snapshot();
          } catch {
            return; // keep the last values; installment_ops_metrics_up says why
          }
          this.reset();
          apply(this, s);
        },
      });

    fromSnapshot(
      'installment_schedules_open',
      'Instalments still to be collected, by status.',
      ['status'],
      (g, s) => {
        for (const [status, n] of Object.entries(s.schedules)) g.set({ status }, n);
      },
    );
    fromSnapshot(
      'installment_schedules_stuck_processing',
      'Instalments in processing for more than 90 minutes: a charge with no outcome.',
      [],
      (g, s) => g.set(s.stuckProcessing),
    );
    fromSnapshot(
      'installment_payouts_in_flight',
      'Merchant payouts without an answer from Paystack yet, by status.',
      ['status'],
      (g, s) => {
        for (const [status, n] of Object.entries(s.payoutsInFlight)) g.set({ status }, n);
      },
    );
    fromSnapshot(
      'installment_payouts_latest_day',
      'How the most recent settlement day ended: payouts by status.',
      ['status'],
      (g, s) => {
        for (const [status, n] of Object.entries(s.latestPayoutDay.byStatus)) {
          g.set({ status }, n);
        }
      },
    );
    fromSnapshot(
      'installment_payouts_latest_day_timestamp_seconds',
      'The as-of date of the most recent settlement day (unix seconds, midnight UTC).',
      [],
      (g, s) => {
        if (s.latestPayoutDay.asOfDate) {
          g.set(Date.parse(`${s.latestPayoutDay.asOfDate}T00:00:00Z`) / 1000);
        }
      },
    );
    fromSnapshot(
      'installment_refunds',
      'Customer refunds by queue, as the console shows them.',
      ['queue'],
      (g, s) => {
        for (const r of s.refunds) g.set({ queue: r.queue }, r.count);
      },
    );
    fromSnapshot(
      'installment_refunds_pesewas',
      'What the refunds in each queue add up to, in pesewas.',
      ['queue'],
      (g, s) => {
        for (const r of s.refunds) g.set({ queue: r.queue }, r.amount_pesewas);
      },
    );
    fromSnapshot(
      'installment_collections_cases_open',
      'Open collections cases, by dunning stage.',
      ['stage'],
      (g, s) => {
        for (const [stage, n] of Object.entries(s.collectionsOpen)) g.set({ stage }, n);
      },
    );
    fromSnapshot(
      'installment_sellers_owing',
      'Sellers whose payable balance is negative: they owe Ejua.',
      [],
      (g, s) => g.set(s.sellersOwing.count),
    );
    fromSnapshot(
      'installment_sellers_owing_pesewas',
      'What sellers with a negative balance owe Ejua in total, in pesewas.',
      [],
      (g, s) => g.set(s.sellersOwing.pesewas),
    );

    // Telco health comes from Redis, not the snapshot, and is cheap to read.
    const telco = this.telco;
    new Gauge({
      name: 'installment_telco_success_ratio',
      help: 'Mobile Money charge success rate over the health window, by network.',
      labelNames: ['telco'] as const,
      registers,
      async collect() {
        this.reset();
        for (const h of await telco.snapshot()) {
          if (h.successRate !== null) this.set({ telco: h.telco }, h.successRate);
        }
      },
    });
    new Gauge({
      name: 'installment_telco_status',
      help: 'Mobile Money network health: 0 healthy, 1 degraded, 2 down, -1 unknown.',
      labelNames: ['telco'] as const,
      registers,
      async collect() {
        this.reset();
        for (const h of await telco.snapshot()) {
          this.set({ telco: h.telco }, TELCO_STATUS_VALUE[h.status] ?? -1);
        }
      },
    });
  }
}
