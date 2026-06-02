import { and, eq, isNull } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import { runInTransaction } from '../../shared/event-bus/transaction';
import { LedgerService } from '../../shared/ledger/ledger.service';
import { MODEL_CONFIG, type BusinessModel } from './model-config';

const held = schema.held_reserves;

/** A query executor that can read + write held_reserves (root client or an open tx). */
export type ReserveExecutor = Pick<Database, 'insert' | 'update' | 'select'>;

const MS_PER_DAY = 86_400_000;
const MS_PER_MONTH = 30 * MS_PER_DAY; // settlement "month" — 30 days, matches the design
/** Sentinel "never matures" date (max safe JS timestamp). */
const NEVER = new Date(8_640_000_000_000_000);

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

export interface ReserveReleaseSummary {
  merchantId: string;
  totalReleasedPesewas: number;
  releases: ReserveReleaseResult[];
}

/**
 * Owns the `held_reserves` lifecycle: records a tracking row when an accrual
 * withholds reserve, stamps the policy triggers (plan completion / delivery),
 * and releases matured reserve back to the merchant's payable balance.
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
    let totalReleased = 0;

    for (const row of openReserves) {
      if (this.computeReleaseDate(row) > asOf) continue; // not matured yet

      const result = await this.releaseOne(row, asOf);
      if (result.releasedPesewas > 0 || result.fullyReleased) {
        releases.push(result);
        totalReleased += result.releasedPesewas;
      }
    }

    return { merchantId, totalReleasedPesewas: totalReleased, releases };
  }

  /** Books one row's matured release + bookkeeping atomically. */
  private async releaseOne(row: HeldReserve, asOf: Date): Promise<ReserveReleaseResult> {
    const desired = this.computeReleaseAmount(row, asOf);
    // Never release more reserve than the ledger still holds for the plan (a
    // refund may have reversed part of it).
    const ledgerBalance = await this.ledger.balanceOf('reserve_held', row.customer_plan_id);
    const amount = Math.max(0, Math.min(desired, ledgerBalance));

    const newReleased = row.released_amount_pesewas + amount;
    // Done when the held_reserves accounting is exhausted, or the ledger has
    // nothing left to give for this plan.
    const fullyReleased =
      newReleased + row.consumed_for_default_pesewas >= row.amount_pesewas ||
      ledgerBalance - amount <= 0;

    if (amount <= 0) {
      // Nothing bookable. Close the row only if it can never release more.
      if (fullyReleased) {
        await this.db
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

    const transactionId = `release:${row.id}:${asOf.toISOString().slice(0, 10)}`;
    const metadata = { held_reserve_id: row.id, model: row.business_model };

    await runInTransaction(this.db, async (tx) => {
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
    });

    return {
      heldReserveId: row.id,
      customerPlanId: row.customer_plan_id,
      releasedPesewas: amount,
      fullyReleased,
    };
  }

  /** When the reserve first becomes releasable (the whole lot, for buffer policies). */
  private computeReleaseDate(row: HeldReserve): Date {
    const policy = MODEL_CONFIG[row.business_model as BusinessModel].reserveReleasePolicy;
    switch (policy.type) {
      case 'after_plan_completion':
        return row.plan_completed_at
          ? new Date(new Date(row.plan_completed_at).getTime() + policy.bufferDays * MS_PER_DAY)
          : NEVER;
      case 'after_delivery':
        return row.delivered_at
          ? new Date(new Date(row.delivered_at).getTime() + policy.bufferDays * MS_PER_DAY)
          : NEVER;
      case 'rolling_monthly':
        // Starts maturing immediately; the amount is gated month-by-month.
        return new Date(row.held_at);
    }
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
    const monthsAlreadyReleased = Math.floor(row.released_amount_pesewas / perMonth);
    const monthsToRelease = monthsElapsed - monthsAlreadyReleased;
    if (monthsToRelease <= 0) return 0;

    return Math.min(perMonth * monthsToRelease, remaining);
  }
}
