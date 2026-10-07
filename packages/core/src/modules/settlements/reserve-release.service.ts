import { and, eq, isNull } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import { runInTransaction } from '../../shared/event-bus/transaction';
import { LedgerService } from '../../shared/ledger/ledger.service';
import { MODEL_CONFIG, type BusinessModel } from './model-config';
import { reserveReleaseDate } from './reserve-policy';

const held = schema.held_reserves;

/** A query executor that can read + write held_reserves (root client or an open tx). */
export type ReserveExecutor = Pick<Database, 'insert' | 'update' | 'select'>;

const MS_PER_DAY = 86_400_000;
const MS_PER_MONTH = 30 * MS_PER_DAY; // settlement "month" — 30 days, matches the design

export type HeldReserve = typeof schema.held_reserves.$inferSelect;

export interface RecordHeldReserveInput {
  merchantId: string;
  customerPlanId: string;
  model: BusinessModel;
  /** The reserve withheld for this accrual (pesewas). */
  amountPesewas: number;
  /** When the reserve was withheld; defaults to now. */
  heldAt?: Date;
}

export interface ReserveReleaseResult {
  heldReserveId: string;
  customerPlanId: string;
  releasedPesewas: number;
  fullyReleased: boolean;
}

export interface ReserveReleaseFailure {
  heldReserveId: string;
  customerPlanId: string;
  /** The error's message — a reserve that would not release needs a name. */
  error: string;
}

export interface ReserveReleaseSummary {
  merchantId: string;
  totalReleasedPesewas: number;
  releases: ReserveReleaseResult[];
  /** Rows that threw. Each is a merchant still waiting on their money. */
  failures: ReserveReleaseFailure[];
}

export interface ReserveSweepSummary {
  asOf: string;
  merchantsChecked: number;
  totalReleasedPesewas: number;
  /** Rows that threw, across every merchant. Non-zero deserves an alert. */
  failedReleases: number;
  perMerchant: ReserveReleaseSummary[];
}

/**
 * Owns the `held_reserves` lifecycle: records a tracking row when an accrual
 * withholds reserve, stamps the policy triggers (plan completion / delivery /
 * default), and releases matured reserve back to the merchant's payable
 * balance.
 *
 * Release is double-entry (ported from docs/design/settlement-engine.ts):
 *
 *   DEBIT  reserve_held[plan]       releaseAmount   (reduce our liability)
 *   CREDIT merchant_payable[merch]  releaseAmount   (we now owe the merchant)
 *
 * Every release is capped at the live `reserve_held` ledger balance for the
 * plan, so a prior refund reversal can never drive the reserve negative.
 */
export class ReserveReleaseService {
  constructor(
    private readonly db: Database,
    private readonly ledger: LedgerService,
  ) {}

  /**
   * Records the held-reserve tracking row for one accrual. No-op (returns null)
   * when nothing was withheld. Runs in the caller's transaction so it commits
   * atomically with the accrual that booked the reserve.
   */
  async recordHeldReserve(
    input: RecordHeldReserveInput,
    tx?: ReserveExecutor,
  ): Promise<HeldReserve | null> {
    if (input.amountPesewas <= 0) return null;
    const exec: ReserveExecutor = tx ?? this.db;
    const [row] = await exec
      .insert(held)
      .values({
        merchant_id: input.merchantId,
        customer_plan_id: input.customerPlanId,
        business_model: input.model,
        amount_pesewas: input.amountPesewas,
        held_at: (input.heldAt ?? new Date()).toISOString(),
      })
      .returning();
    return row ?? null;
  }

  /**
   * Stamps `plan_completed_at` on every still-open reserve for the plan. Idempotent
   * — only rows that don't already carry the timestamp are touched.
   */
  async markPlanCompleted(customerPlanId: string, at: Date, tx?: ReserveExecutor): Promise<void> {
    const exec: ReserveExecutor = tx ?? this.db;
    await exec
      .update(held)
      .set({ plan_completed_at: at.toISOString() })
      .where(
        and(
          eq(held.customer_plan_id, customerPlanId),
          isNull(held.plan_completed_at),
          isNull(held.fully_released_at),
        ),
      );
  }

  /**
   * Stamps `delivered_at` on every still-open reserve for the plan (drives the
   * `after_delivery` release policy used by layaway).
   */
  async markDelivered(customerPlanId: string, at: Date, tx?: ReserveExecutor): Promise<void> {
    const exec: ReserveExecutor = tx ?? this.db;
    await exec
      .update(held)
      .set({ delivered_at: at.toISOString() })
      .where(
        and(
          eq(held.customer_plan_id, customerPlanId),
          isNull(held.delivered_at),
          isNull(held.fully_released_at),
        ),
      );
  }

  /**
   * Stamps `plan_defaulted_at` on every still-open reserve for the plan.
   *
   * A defaulted plan will never complete and will never be delivered, so
   * without this the buffer policies wait on a trigger that can no longer fire
   * and the reserve left over after the default's loss allocation stays
   * withheld forever. Idempotent — only unstamped rows are touched.
   */
  async markPlanDefaulted(customerPlanId: string, at: Date, tx?: ReserveExecutor): Promise<void> {
    const exec: ReserveExecutor = tx ?? this.db;
    await exec
      .update(held)
      .set({ plan_defaulted_at: at.toISOString() })
      .where(
        and(
          eq(held.customer_plan_id, customerPlanId),
          isNull(held.plan_defaulted_at),
          isNull(held.fully_released_at),
        ),
      );
  }

  /**
   * Marks reserve consumed to cover a plan default — held_reserves bookkeeping
   * only; the matching `reserve_held` ledger debit is the caller's job (see
   * DefaultService). Consumes across the plan's open rows up to what each still
   * holds (amount − released − consumed), closing rows that become exhausted so
   * the release sweep skips them. Returns the amount actually consumed.
   */
  async consumeForDefault(
    customerPlanId: string,
    amountPesewas: number,
    tx?: ReserveExecutor,
  ): Promise<number> {
    if (amountPesewas <= 0) return 0;
    const exec: ReserveExecutor = tx ?? this.db;
    const rows = await exec
      .select()
      .from(held)
      .where(and(eq(held.customer_plan_id, customerPlanId), isNull(held.fully_released_at)));

    const nowIso = new Date().toISOString();
    let remaining = amountPesewas;
    let consumed = 0;
    for (const row of rows) {
      if (remaining <= 0) break;
      const available =
        row.amount_pesewas - row.released_amount_pesewas - row.consumed_for_default_pesewas;
      if (available <= 0) continue;
      const take = Math.min(available, remaining);
      const newConsumed = row.consumed_for_default_pesewas + take;
      const exhausted = row.released_amount_pesewas + newConsumed >= row.amount_pesewas;
      await exec
        .update(held)
        .set({
          consumed_for_default_pesewas: newConsumed,
          ...(exhausted ? { fully_released_at: nowIso } : {}),
        })
        .where(eq(held.id, row.id));
      remaining -= take;
      consumed += take;
    }
    return consumed;
  }

  /**
   * Releases every matured reserve for a merchant as of `asOf`. Each release is
   * its own transaction (ledger entries + the held_reserves bookkeeping commit
   * together) so a failure on one row doesn't roll back the others — a re-run
   * picks up where it left off.
   */
  async releaseMaturedReserves(
    merchantId: string,
    asOf: Date = new Date(),
  ): Promise<ReserveReleaseSummary> {
    const openReserves = await this.db
      .select()
      .from(held)
      .where(and(eq(held.merchant_id, merchantId), isNull(held.fully_released_at)));

    const releases: ReserveReleaseResult[] = [];
    const failures: ReserveReleaseFailure[] = [];
    let totalReleased = 0;

    for (const row of openReserves) {
      const releasableFrom = reserveReleaseDate(row);
      // null = the policy's trigger has not fired yet (no completion, no
      // delivery, no default), so there is nothing to mature.
      if (!releasableFrom || releasableFrom > asOf) continue;

      // Per-row isolation, which is the half of this method's contract that
      // the per-row transaction does not provide. Without the catch, one bad
      // row ended the sweep for every row after it — and, through runSweep,
      // for every merchant after this one.
      try {
        const result = await this.releaseOne(row, asOf);
        if (result.releasedPesewas > 0 || result.fullyReleased) {
          releases.push(result);
          totalReleased += result.releasedPesewas;
        }
      } catch (err) {
        failures.push({
          heldReserveId: row.id,
          customerPlanId: row.customer_plan_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { merchantId, totalReleasedPesewas: totalReleased, releases, failures };
  }

  /**
   * Walks every merchant with an open held-reserve row and runs the maturity
   * release for them. Drives the daily reserve-release cron — at worst it does
   * one no-op pass per merchant (each row is filtered by its own maturity
   * date), which is what we want for an idempotent sweep.
   */
  async runSweep(asOf: Date = new Date()): Promise<ReserveSweepSummary> {
    const merchants = await this.db
      .selectDistinct({ merchantId: held.merchant_id })
      .from(held)
      .where(isNull(held.fully_released_at));

    const perMerchant: ReserveReleaseSummary[] = [];
    let totalReleased = 0;
    let failedReleases = 0;
    for (const { merchantId } of merchants) {
      // releaseMaturedReserves already isolates per row; this guards against
      // the surrounding query failing for one merchant (a lock timeout, a
      // dropped connection) taking every later merchant down with it.
      try {
        const summary = await this.releaseMaturedReserves(merchantId, asOf);
        perMerchant.push(summary);
        totalReleased += summary.totalReleasedPesewas;
        failedReleases += summary.failures.length;
      } catch (err) {
        perMerchant.push({
          merchantId,
          totalReleasedPesewas: 0,
          releases: [],
          failures: [
            {
              heldReserveId: '',
              customerPlanId: '',
              error: err instanceof Error ? err.message : String(err),
            },
          ],
        });
        failedReleases += 1;
      }
    }

    return {
      asOf: asOf.toISOString(),
      merchantsChecked: merchants.length,
      totalReleasedPesewas: totalReleased,
      failedReleases,
      perMerchant,
    };
  }

  /**
   * Books one row's matured release + bookkeeping atomically.
   *
   * Everything — the row read, the maturity maths, the ledger posting and the
   * bookkeeping write — happens inside one transaction with the `held_reserves`
   * row locked `FOR UPDATE`. The sweep's outer read is only a candidate list:
   * by the time we get here another sweep (or a default consuming the reserve)
   * may already have moved the row on, and releasing twice from a stale copy
   * would credit the merchant money that is not theirs on a ledger that cannot
   * be edited afterwards.
   */
  private async releaseOne(candidate: HeldReserve, asOf: Date): Promise<ReserveReleaseResult> {
    return runInTransaction(this.db, async (tx) => {
      const row = (
        await tx.select().from(held).where(eq(held.id, candidate.id)).for('update').limit(1)
      )[0];
      // Closed while we queued behind the lock — nothing left to do.
      if (!row || row.fully_released_at) {
        return {
          heldReserveId: candidate.id,
          customerPlanId: candidate.customer_plan_id,
          releasedPesewas: 0,
          fullyReleased: true,
        };
      }

      const desired = this.computeReleaseAmount(row, asOf);
      // Never release more reserve than the ledger still holds for the plan (a
      // refund or a default may have drawn part of it down).
      const ledgerBalance = await this.ledger.balanceOf('reserve_held', row.customer_plan_id, tx);
      // `Number.isFinite` rather than `> 0`: a non-finite amount passes every
      // `<= 0` guard below and only fails at the ledger, which is far too late
      // to tell which row was at fault.
      const bookable = Number.isFinite(desired) && Number.isFinite(ledgerBalance);
      const amount = bookable ? Math.max(0, Math.min(desired, ledgerBalance)) : 0;

      const newReleased = row.released_amount_pesewas + amount;
      // Done when the held_reserves accounting is exhausted, or the ledger has
      // nothing left to give for this plan.
      const fullyReleased =
        newReleased + row.consumed_for_default_pesewas >= row.amount_pesewas ||
        ledgerBalance - amount <= 0;

      if (amount <= 0) {
        // Nothing bookable. Close the row only if it can never release more.
        if (fullyReleased) {
          await tx
            .update(held)
            .set({ fully_released_at: asOf.toISOString() })
            .where(eq(held.id, row.id));
        }
        return {
          heldReserveId: row.id,
          customerPlanId: row.customer_plan_id,
          releasedPesewas: 0,
          fullyReleased,
        };
      }

      // Keyed on the cumulative released total rather than the calendar day:
      // "this row has now released N in total" is unique for the row's whole
      // life, so `ledger_posting_identity_uq` rejects a replay even across a
      // day boundary, and a rolling_monthly row can release twice in one day
      // without colliding with itself.
      const transactionId = `release:${row.id}:${newReleased}`;
      const metadata = { held_reserve_id: row.id, model: row.business_model };

      await this.ledger.record(
        [
          {
            transactionId,
            accountType: 'reserve_held',
            accountRef: row.customer_plan_id,
            direction: 'debit',
            amountPesewas: amount,
            description: `Reserve release for plan ${row.customer_plan_id}`,
            metadata,
          },
          {
            transactionId,
            accountType: 'merchant_payable',
            accountRef: row.merchant_id,
            direction: 'credit',
            amountPesewas: amount,
            description: `Reserve released to merchant`,
            metadata,
          },
        ],
        tx,
      );
      await tx
        .update(held)
        .set({
          released_amount_pesewas: newReleased,
          last_release_at: asOf.toISOString(),
          ...(fullyReleased ? { fully_released_at: asOf.toISOString() } : {}),
        })
        .where(eq(held.id, row.id));

      return {
        heldReserveId: row.id,
        customerPlanId: row.customer_plan_id,
        releasedPesewas: amount,
        fullyReleased,
      };
    });
  }

  /**
   * How much of the row is releasable as of `asOf`, net of what's already gone.
   * Buffer policies release the whole remainder once matured; rolling_monthly
   * releases 1/N per elapsed 30-day month and flushes any rounding dust in the
   * final month.
   */
  private computeReleaseAmount(row: HeldReserve, asOf: Date): number {
    const policy = MODEL_CONFIG[row.business_model as BusinessModel].reserveReleasePolicy;
    const remaining =
      row.amount_pesewas - row.released_amount_pesewas - row.consumed_for_default_pesewas;
    if (remaining <= 0) return 0;

    if (policy.type !== 'rolling_monthly') return remaining;

    const monthsElapsed = Math.floor(
      (asOf.getTime() - new Date(row.held_at).getTime()) / MS_PER_MONTH,
    );
    if (monthsElapsed <= 0) return 0;
    // Term complete → flush everything left (clears the per-month rounding dust).
    if (monthsElapsed >= policy.months) return remaining;

    const perMonth = Math.floor(row.amount_pesewas / policy.months);
    // A reserve smaller than its term in months has no whole-pesewa monthly
    // slice. Dividing by the resulting zero produced NaN, and every guard
    // between here and the ledger is a `<= 0` comparison — which NaN fails —
    // so it travelled all the way to `ledger.record` and threw there, taking
    // the rest of the sweep with it. There is nothing to dribble out monthly,
    // so release the remainder once the first month has elapsed.
    if (perMonth <= 0) return remaining;

    const monthsAlreadyReleased = Math.floor(row.released_amount_pesewas / perMonth);
    const monthsToRelease = monthsElapsed - monthsAlreadyReleased;
    if (monthsToRelease <= 0) return 0;

    return Math.min(perMonth * monthsToRelease, remaining);
  }
}
