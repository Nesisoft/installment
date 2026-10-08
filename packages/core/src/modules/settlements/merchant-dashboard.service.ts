import { and, asc, count, desc, eq, gte, isNotNull, isNull, lt, sql, sum } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import { LedgerService } from '../../shared/ledger/ledger.service';
import { reserveReleaseDate } from './reserve-policy';
import { buildMerchantStatement, type MerchantStatement } from './merchant-statement';

const cp = schema.customer_plans;
const ledgerTbl = schema.ledger_entries;
const payoutsTbl = schema.payouts;
const heldTbl = schema.held_reserves;
const merchantsTbl = schema.merchants;

export interface MerchantBalances {
  merchantId: string;
  /** Live `merchant_payable` balance (what we currently owe the merchant, pesewas). */
  payablePesewas: number;
  /** Sum of `reserve_held` for the merchant's plans (still withheld, pesewas). */
  reserveHeldPesewas: number;
  /** Lifetime payouts that reached `settled` (pesewas). */
  lifetimeSettledPesewas: number;
  /** Open held_reserves rows (bookkeeping, not the ledger balance). */
  openReservesCount: number;
  /** Active customer_plans for this merchant. */
  activePlans: number;
}

export interface MerchantPayoutRow {
  id: string;
  reference: string;
  asOfDate: string;
  amountPesewas: number;
  status: string;
  paystackTransferCode: string | null;
  initiatedAt: string;
  settledAt: string | null;
  failedAt: string | null;
  lastError: string | null;
}

export interface MerchantPayoutsPage {
  rows: MerchantPayoutRow[];
  total: number;
}

export interface MerchantHeldReserveRow {
  id: string;
  customerPlanId: string;
  businessModel: string;
  amountPesewas: number;
  releasedPesewas: number;
  consumedForDefaultPesewas: number;
  /** What's still owed for release (amount − released − consumed). */
  outstandingPesewas: number;
  heldAt: string;
  planCompletedAt: string | null;
  deliveredAt: string | null;
  /** Set when the plan defaulted — the terminal trigger for a buffer policy. */
  planDefaultedAt: string | null;
  /** Earliest date the policy allows release (null = waiting on a trigger). */
  releasableFrom: string | null;
  fullyReleasedAt: string | null;
}

export interface PlanSettlementView {
  customerPlanId: string;
  merchantId: string;
  businessModel: string;
  orderAmountPesewas: number;
  status: string;
  /** Sum of all `accrue:{plan}:*` receivable debits booked. */
  grossAccruedPesewas: number;
  /** Sum of `refund:*` receivable credits booked against this plan. */
  refundedPesewas: number;
  reserveHeldPesewas: number;
  defaultWrittenOffPesewas: number;
  /** Default loss absorbed by the merchant (debit on merchant_payable). */
  defaultClawedFromMerchantPesewas: number;
  /** Default loss absorbed by the reserve withheld for this plan. */
  defaultConsumedFromReservePesewas: number;
}

/**
 * Read-only aggregations for the merchant dashboard. Reads cross multiple
 * tables (live ledger balances, payouts history, held_reserves bookkeeping)
 * and shape them into a single view per concern. No writes — every consumer
 * must respect the source-of-truth ordering: `LedgerService.balanceOf` for
 * cash positions, the bookkeeping rows for lifecycle metadata.
 */
export class MerchantDashboardService {
  constructor(
    private readonly db: Database,
    private readonly ledger: LedgerService,
  ) {}

  /** Snapshot of what a merchant currently has with us. */
  async getBalances(merchantId: string): Promise<MerchantBalances> {
    const [payable, lifetimeRows, reserveSummary, openReservesRow, activeRow] = await Promise.all([
      this.ledger.balanceOf('merchant_payable', merchantId),
      this.db
        .select({ total: sum(payoutsTbl.amount_pesewas) })
        .from(payoutsTbl)
        .where(and(eq(payoutsTbl.merchant_id, merchantId), eq(payoutsTbl.status, 'settled'))),
      this.db
        .select({
          amount: sum(heldTbl.amount_pesewas),
          released: sum(heldTbl.released_amount_pesewas),
          consumed: sum(heldTbl.consumed_for_default_pesewas),
        })
        .from(heldTbl)
        .where(eq(heldTbl.merchant_id, merchantId)),
      this.db
        .select({ n: count() })
        .from(heldTbl)
        .where(and(eq(heldTbl.merchant_id, merchantId), isNull(heldTbl.fully_released_at))),
      this.db
        .select({ n: count() })
        .from(cp)
        .where(and(eq(cp.merchant_id, merchantId), eq(cp.status, 'active'))),
    ]);

    const reserveAmount = toNum(reserveSummary[0]?.amount);
    const reserveReleased = toNum(reserveSummary[0]?.released);
    const reserveConsumed = toNum(reserveSummary[0]?.consumed);

    return {
      merchantId,
      payablePesewas: payable,
      reserveHeldPesewas: Math.max(0, reserveAmount - reserveReleased - reserveConsumed),
      lifetimeSettledPesewas: toNum(lifetimeRows[0]?.total),
      openReservesCount: Number(openReservesRow[0]?.n ?? 0),
      activePlans: Number(activeRow[0]?.n ?? 0),
    };
  }

  /** Recent payouts, newest first. Filterable by status; paginated. */
  async listPayouts(
    merchantId: string,
    opts: { status?: string; limit?: number; offset?: number } = {},
  ): Promise<MerchantPayoutsPage> {
    const limit = Math.min(opts.limit ?? 50, 200);
    const offset = Math.max(0, opts.offset ?? 0);
    const filters = [eq(payoutsTbl.merchant_id, merchantId)];
    if (opts.status) filters.push(eq(payoutsTbl.status, opts.status));
    const where = filters.length === 1 ? filters[0] : and(...filters);

    const [rows, totalRow] = await Promise.all([
      this.db
        .select()
        .from(payoutsTbl)
        .where(where)
        // Unique final term so the paged list cannot repeat or skip a payout.
        .orderBy(desc(payoutsTbl.initiated_at), desc(payoutsTbl.id))
        .limit(limit)
        .offset(offset),
      this.db.select({ n: count() }).from(payoutsTbl).where(where),
    ]);

    return {
      rows: rows.map((r) => ({
        id: r.id,
        reference: r.reference,
        asOfDate: r.as_of_date,
        amountPesewas: r.amount_pesewas,
        status: r.status,
        paystackTransferCode: r.paystack_transfer_code,
        initiatedAt: r.initiated_at,
        settledAt: r.settled_at,
        failedAt: r.failed_at,
        lastError: r.last_error,
      })),
      total: Number(totalRow[0]?.n ?? 0),
    };
  }

  /**
   * Held reserves for a merchant. `open=true` (default) returns rows still
   * carrying a balance; `open=false` returns fully released/consumed history.
   */
  async listHeldReserves(
    merchantId: string,
    opts: { open?: boolean } = {},
  ): Promise<MerchantHeldReserveRow[]> {
    const open = opts.open ?? true;
    const rows = await this.db
      .select()
      .from(heldTbl)
      .where(
        and(
          eq(heldTbl.merchant_id, merchantId),
          open ? isNull(heldTbl.fully_released_at) : isNotNull(heldTbl.fully_released_at),
        ),
      )
      .orderBy(desc(heldTbl.held_at));

    return rows.map((r) => ({
      id: r.id,
      customerPlanId: r.customer_plan_id,
      businessModel: r.business_model,
      amountPesewas: r.amount_pesewas,
      releasedPesewas: r.released_amount_pesewas,
      consumedForDefaultPesewas: r.consumed_for_default_pesewas,
      outstandingPesewas: Math.max(
        0,
        r.amount_pesewas - r.released_amount_pesewas - r.consumed_for_default_pesewas,
      ),
      heldAt: r.held_at,
      planCompletedAt: r.plan_completed_at,
      deliveredAt: r.delivered_at,
      planDefaultedAt: r.plan_defaulted_at,
      releasableFrom: this.releasableFrom(r),
      fullyReleasedAt: r.fully_released_at,
    }));
  }

  /** Per-plan settlement view — accruals, refunds, reserve, default footprint. */
  async getPlanSettlement(customerPlanId: string): Promise<PlanSettlementView | null> {
    const plan = (await this.db.select().from(cp).where(eq(cp.id, customerPlanId)).limit(1))[0];
    if (!plan) return null;

    const defaultTxId = `default:${customerPlanId}`;
    const [accrued, refunded, reserve, defaultRows] = await Promise.all([
      this.sumLedgerByPrefix('receivable', customerPlanId, 'debit', `accrue:${customerPlanId}:`),
      this.sumLedgerByPrefix('receivable', customerPlanId, 'credit', `refund:`),
      this.ledger.balanceOf('reserve_held', customerPlanId),
      this.db
        .select()
        .from(ledgerTbl)
        .where(and(eq(ledgerTbl.transaction_id, defaultTxId))),
    ]);

    let defaultWrittenOff = 0;
    let defaultFromMerchant = 0;
    let defaultFromReserve = 0;
    for (const r of defaultRows) {
      const amt = Number(r.amount_pesewas);
      if (r.account_type === 'receivable' && r.direction === 'credit') defaultWrittenOff += amt;
      else if (r.account_type === 'merchant_payable' && r.direction === 'debit')
        defaultFromMerchant += amt;
      else if (r.account_type === 'reserve_held' && r.direction === 'debit')
        defaultFromReserve += amt;
    }

    return {
      customerPlanId,
      merchantId: plan.merchant_id,
      businessModel: plan.business_model,
      orderAmountPesewas: plan.order_amount_pesewas,
      status: plan.status,
      grossAccruedPesewas: accrued,
      refundedPesewas: refunded,
      reserveHeldPesewas: reserve,
      defaultWrittenOffPesewas: defaultWrittenOff,
      defaultClawedFromMerchantPesewas: defaultFromMerchant,
      defaultConsumedFromReservePesewas: defaultFromReserve,
    };
  }

  /**
   * Monthly account statement for a merchant — every `merchant_payable`
   * movement in the calendar month (UTC), with the opening balance carried in
   * from all prior activity and the closing balance rolled forward. `month` is
   * 1-based.
   */
  async getMonthlyStatement(
    merchantId: string,
    year: number,
    month: number,
  ): Promise<MerchantStatement> {
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw new RangeError(`month must be 1..12, got ${month}`);
    }
    const startIso = new Date(Date.UTC(year, month - 1, 1)).toISOString();
    const endIso = new Date(Date.UTC(year, month, 1)).toISOString();

    const payableFilter = and(
      eq(ledgerTbl.account_type, 'merchant_payable'),
      eq(ledgerTbl.account_ref, merchantId),
    );

    const [merchantRow, openingRows, entryRows] = await Promise.all([
      this.db
        .select({ name: merchantsTbl.business_name })
        .from(merchantsTbl)
        .where(eq(merchantsTbl.id, merchantId))
        .limit(1),
      // Opening balance = signed sum of every movement strictly before the period.
      this.db
        .select({
          balance: sql<string>`coalesce(sum(${ledgerTbl.amount_pesewas} * case ${ledgerTbl.direction} when 'credit' then 1 else -1 end), 0)`,
        })
        .from(ledgerTbl)
        .where(and(payableFilter, lt(ledgerTbl.occurred_at, startIso))),
      this.db
        .select({
          occurredAt: ledgerTbl.occurred_at,
          transactionId: ledgerTbl.transaction_id,
          description: ledgerTbl.description,
          direction: ledgerTbl.direction,
          amountPesewas: ledgerTbl.amount_pesewas,
        })
        .from(ledgerTbl)
        .where(
          and(
            payableFilter,
            gte(ledgerTbl.occurred_at, startIso),
            lt(ledgerTbl.occurred_at, endIso),
          ),
        )
        .orderBy(asc(ledgerTbl.occurred_at)),
    ]);

    return buildMerchantStatement({
      merchantId,
      merchantName: merchantRow[0]?.name ?? null,
      year,
      month,
      openingBalancePesewas: Number(openingRows[0]?.balance ?? '0'),
      entries: entryRows.map((e) => ({
        occurredAt: e.occurredAt,
        transactionId: e.transactionId,
        description: e.description,
        direction: e.direction as 'debit' | 'credit',
        amountPesewas: Number(e.amountPesewas),
      })),
    });
  }

  /**
   * Earliest date the policy lets us release this row, given the stamped
   * triggers — the same function the release sweep decides on, so the console
   * can never promise a date the sweep disagrees with.
   */
  private releasableFrom(row: typeof schema.held_reserves.$inferSelect): string | null {
    return reserveReleaseDate(row)?.toISOString() ?? null;
  }

  /** Sums the matching debits or credits whose transaction_id starts with `prefix`. */
  private async sumLedgerByPrefix(
    accountType: 'receivable' | 'merchant_payable' | 'reserve_held',
    accountRef: string,
    direction: 'debit' | 'credit',
    prefix: string,
  ): Promise<number> {
    // `like` would mean importing it and a SQL pattern — keep it in JS for clarity
    // and avoid the perf hit of a LIKE scan on a small per-plan slice.
    const rows = await this.db
      .select({ tx: ledgerTbl.transaction_id, amount: ledgerTbl.amount_pesewas })
      .from(ledgerTbl)
      .where(
        and(
          eq(ledgerTbl.account_type, accountType),
          eq(ledgerTbl.account_ref, accountRef),
          eq(ledgerTbl.direction, direction),
        ),
      );
    return rows.filter((r) => r.tx.startsWith(prefix)).reduce((s, r) => s + Number(r.amount), 0);
  }
}

function toNum(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  return typeof v === 'number' ? v : Number(v);
}
