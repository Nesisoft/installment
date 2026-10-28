import { sql } from 'drizzle-orm';
import type { Database } from '@installment/db';
import type { RefundQueueTotal, RefundService } from '../refunds/refund.service';

/** Instalment statuses that are still somebody's work. Terminal ones are history. */
export const OPEN_SCHEDULE_STATUSES = [
  'due',
  'processing',
  'retry_scheduled',
  'overdue',
  'in_collections',
] as const;

/** Payout statuses that have not reached an answer. */
export const IN_FLIGHT_PAYOUT_STATUSES = ['initiated', 'pending_confirmation', 'unknown'] as const;

/**
 * How long an instalment may sit in `processing` before it counts as stuck —
 * the same threshold the stuck-schedule sweep uses, so the gauge and the alert
 * agree about what "stuck" means.
 */
export const STUCK_PROCESSING_MINUTES = 90;

export interface OpsSnapshot {
  /** Open instalments by status. */
  schedules: Record<(typeof OPEN_SCHEDULE_STATUSES)[number], number>;
  /** Instalments in `processing` for longer than {@link STUCK_PROCESSING_MINUTES}. */
  stuckProcessing: number;
  /** Payouts without an answer yet, by status, across every day. */
  payoutsInFlight: Record<(typeof IN_FLIGHT_PAYOUT_STATUSES)[number], number>;
  /** How the most recent settlement day ended, by status. Empty before the first run. */
  latestPayoutDay: { asOfDate: string | null; byStatus: Record<string, number> };
  /** Refunds by queue — the same queues the console's Refunds page shows. */
  refunds: RefundQueueTotal[];
  /** Open collections cases by stage. */
  collectionsOpen: Record<string, number>;
  /** Sellers whose payable balance is negative: they owe Ejua. */
  sellersOwing: { count: number; pesewas: number };
}

/**
 * The operational backlog as numbers, for the metrics endpoint.
 *
 * Each figure is something a runbook acts on: instalments stuck mid-charge,
 * payouts with no answer, refunds waiting on a person, cases by stage, sellers
 * who owe money. Sentry alerts on these as they happen; this is what lets a
 * dashboard show the level, and an alert rule notice a level that never falls.
 *
 * Read on demand, and nothing here writes. The counts are over indexed status
 * columns. The sellers-owing figure is the exception: it sums every
 * `merchant_payable` ledger entry, which is cheap at pilot scale but grows with
 * the ledger. If it ever shows in query timing, read it from a maintained
 * balance instead.
 */
export class OpsMetricsService {
  constructor(
    private readonly db: Database,
    private readonly refunds: Pick<RefundService, 'summary'>,
  ) {}

  async snapshot(now: Date = new Date()): Promise<OpsSnapshot> {
    const stuckBefore = new Date(now.getTime() - STUCK_PROCESSING_MINUTES * 60_000).toISOString();

    const [scheduleRows, stuckRows, inFlightRows, latestDayRows, caseRows, owingRows, refunds] =
      await Promise.all([
        this.db.execute(sql`
          SELECT status, count(*)::int AS n FROM installment_schedule
          WHERE status IN (${sql.join(
            OPEN_SCHEDULE_STATUSES.map((s) => sql`${s}`),
            sql`, `,
          )})
          GROUP BY status`),
        this.db.execute(sql`
          SELECT count(*)::int AS n FROM installment_schedule
          WHERE status = 'processing' AND status_changed_at < ${stuckBefore}::timestamptz`),
        this.db.execute(sql`
          SELECT status, count(*)::int AS n FROM payouts
          WHERE status IN (${sql.join(
            IN_FLIGHT_PAYOUT_STATUSES.map((s) => sql`${s}`),
            sql`, `,
          )})
          GROUP BY status`),
        this.db.execute(sql`
          SELECT as_of_date::text AS day, status, count(*)::int AS n FROM payouts
          WHERE as_of_date = (SELECT max(as_of_date) FROM payouts)
          GROUP BY as_of_date, status`),
        this.db.execute(sql`
          SELECT current_stage AS stage, count(*)::int AS n FROM collections_cases
          WHERE closed_at IS NULL GROUP BY current_stage`),
        // A payable is a liability: credits are what Ejua owes the seller, debits
        // what it has paid or taken back. Below zero, the seller owes Ejua.
        this.db.execute(sql`
          SELECT count(*)::int AS n, coalesce(sum(-balance), 0)::text AS pesewas FROM (
            SELECT account_ref,
                   sum(CASE WHEN direction = 'credit' THEN amount_pesewas
                            ELSE -amount_pesewas END) AS balance
            FROM ledger_entries WHERE account_type = 'merchant_payable'
            GROUP BY account_ref
          ) payable WHERE balance < 0`),
        this.refunds.summary(),
      ]);

    const counts = <K extends string>(keys: readonly K[], rows: unknown[], key = 'status') => {
      const out = Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
      for (const r of rows as Array<Record<string, unknown>>) {
        const k = String(r[key]) as K;
        if (k in out) out[k] = Number(r.n);
      }
      return out;
    };

    const latestRows = latestDayRows.rows as Array<{ day: string; status: string; n: number }>;
    const owing = (owingRows.rows as Array<{ n: number; pesewas: string }>)[0];

    return {
      schedules: counts(OPEN_SCHEDULE_STATUSES, scheduleRows.rows),
      stuckProcessing: Number((stuckRows.rows as Array<{ n: number }>)[0]?.n ?? 0),
      payoutsInFlight: counts(IN_FLIGHT_PAYOUT_STATUSES, inFlightRows.rows),
      latestPayoutDay: {
        asOfDate: latestRows[0]?.day ?? null,
        byStatus: Object.fromEntries(latestRows.map((r) => [r.status, Number(r.n)])),
      },
      refunds,
      collectionsOpen: Object.fromEntries(
        (caseRows.rows as Array<{ stage: string; n: number }>).map((r) => [r.stage, Number(r.n)]),
      ),
      sellersOwing: { count: Number(owing?.n ?? 0), pesewas: Number(owing?.pesewas ?? 0) },
    };
  }
}
