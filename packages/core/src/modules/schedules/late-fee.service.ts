import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import { Money } from '../../shared/money/money';
import { runInTransaction } from '../../shared/event-bus/transaction';
import { AuditLogger } from '../audit/audit-logger.service';
import { SYSTEM_ACTORS } from '../../shared/constants/system-actors';

const sched = schema.installment_schedule;
const cp = schema.customer_plans;

/** Statuses where an unpaid instalment can still accrue a fee. */
const ACCRUABLE_STATUSES = ['pending', 'due', 'failed', 'retry_scheduled', 'overdue'] as const;

const MS_PER_DAY = 86_400_000;

export interface LateFeeAccrual {
  scheduleId: string;
  planId: string;
  weeksLate: number;
  previousFeePesewas: number;
  feePesewas: number;
  capped: boolean;
}

/**
 * Accrues the late fee an overdue instalment has earned.
 *
 * The design and the business proposal both promise "3-day grace, then 2% per
 * week, capped at 15%". None of it existed: `plan_templates.late_fee_pesewas`
 * was a flat amount that was never copied onto a plan, and
 * `installment_schedule.late_fee_pesewas` was read in five places and written in
 * none — so the app would have been quoting a penalty the system could not
 * charge. Migration 0015 adds the rate and the cap to templates and plans; this
 * is what moves the number.
 *
 * Collection already worked and is untouched: `finalisePaidInstallment` settles
 * `amount_due + late_fee`, so a fee accrued here is collected by the very next
 * charge without any change to the payment path.
 *
 * Three properties this deliberately guarantees:
 *
 *  - **Grace is free.** The clock starts at `grace_until_date`, not `due_date`.
 *  - **The fee is a level, not an increment.** Each run recomputes the whole fee
 *    from weeks elapsed and writes it, so running twice in a day, or catching up
 *    after an outage, cannot double-charge. `late_fee_accrued_at` exists to skip
 *    work, not to keep the sum correct.
 *  - **The cap is on the instalment**, so a fee can never exceed
 *    `late_fee_cap_bps` of what was owed however long a row sits.
 */
export class LateFeeService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditLogger,
  ) {}

  /**
   * Recomputes fees for every instalment past its grace date on a plan carrying
   * a late-fee rate. Returns what changed; rows already at the right level are
   * left alone and not reported.
   */
  async accrue(now: Date = new Date(), limit = 1_000): Promise<LateFeeAccrual[]> {
    const today = now.toISOString().slice(0, 10);

    const candidates = await this.db
      .select({
        id: sched.id,
        plan_id: sched.customer_plan_id,
        amount_due: sched.amount_due_pesewas,
        late_fee: sched.late_fee_pesewas,
        grace_until: sched.grace_until_date,
        version: sched.version,
        rate_bps: cp.late_fee_bps_per_week,
        cap_bps: cp.late_fee_cap_bps,
      })
      .from(sched)
      .innerJoin(cp, eq(cp.id, sched.customer_plan_id))
      .where(
        and(
          inArray(sched.status, [...ACCRUABLE_STATUSES]),
          lt(sched.grace_until_date, today),
          // A plan sold without a late-fee rate never grows one, even if the
          // template is repriced later: the plan is the contract.
          sql`${cp.late_fee_bps_per_week} > 0`,
        ),
      )
      .limit(limit);

    const applied: LateFeeAccrual[] = [];

    for (const row of candidates) {
      const weeksLate = weeksSince(row.grace_until, now);
      if (weeksLate <= 0) continue;

      const due = Money.fromPesewas(row.amount_due);
      // One multiplication at the compounded rate rather than N weekly roundings:
      // rounding each week and summing drifts upward against the customer.
      const uncapped = Number(due.multiplyBps(row.rate_bps * weeksLate).pesewas);
      const cap = row.cap_bps > 0 ? Number(due.multiplyBps(row.cap_bps).pesewas) : uncapped;
      const fee = Math.min(uncapped, cap);

      if (fee === row.late_fee) continue;
      // Only ever upward. A fee already charged and collected must not be
      // rewritten downward by a later run — the customer has paid it.
      if (fee < row.late_fee) continue;

      await runInTransaction(this.db, async (tx) => {
        // The same optimistic guard the payment path uses: if a charge settled
        // this row while we were computing, the update finds no row and the
        // accrual is simply skipped rather than resurrecting a fee on a paid
        // instalment.
        const updated = await tx
          .update(sched)
          .set({
            late_fee_pesewas: fee,
            late_fee_accrued_at: now.toISOString(),
            version: row.version + 1,
          })
          .where(
            and(
              eq(sched.id, row.id),
              eq(sched.version, row.version),
              inArray(sched.status, [...ACCRUABLE_STATUSES]),
            ),
          )
          .returning({ id: sched.id });
        if (!updated[0]) return;

        await this.audit.append(tx, {
          entityType: 'installment_schedule',
          entityId: row.id,
          eventType: 'installment.late_fee_accrued',
          actorId: SYSTEM_ACTORS.SYSTEM,
          actorType: 'system',
          metadata: {
            weeks_late: weeksLate,
            previous_fee_pesewas: row.late_fee,
            late_fee_pesewas: fee,
            capped: fee === cap && cap < uncapped,
          },
        });

        applied.push({
          scheduleId: row.id,
          planId: row.plan_id,
          weeksLate,
          previousFeePesewas: row.late_fee,
          feePesewas: fee,
          capped: fee === cap && cap < uncapped,
        });
      });
    }

    return applied;
  }
}

/**
 * Whole weeks elapsed since grace ended.
 *
 * Whole weeks, not fractions: "2% per week" means the second week's fee lands
 * when the second week starts, and charging 0.28% on day one would be a rate
 * nobody was quoted. Dates are UTC — Ghana is UTC+0, and the engine's date
 * arithmetic is UTC throughout.
 */
function weeksSince(graceUntilDate: string, now: Date): number {
  const grace = Date.parse(`${graceUntilDate}T00:00:00.000Z`);
  if (Number.isNaN(grace)) return 0;
  const days = Math.floor((now.getTime() - grace) / MS_PER_DAY);
  if (days <= 0) return 0;
  return Math.floor(days / 7) + 1;
}
