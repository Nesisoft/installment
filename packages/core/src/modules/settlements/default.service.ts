import { eq } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import { LedgerService, type LedgerEntryInput } from '../../shared/ledger/ledger.service';
import { ReserveReleaseService, type ReserveExecutor } from './reserve-release.service';
import { SETTLEMENT_CASH_REF } from './settlement.service';
import type { BusinessModel } from './model-config';

const ledger = schema.ledger_entries;

export interface HandleDefaultInput {
  customerPlanId: string;
  merchantId: string;
  model: BusinessModel;
  /**
   * The customer balance we won't recover (pesewas). The loss allocated is at
   * most what the platform has fronted on the plan — see `handleDefault`.
   */
  unrecoveredAmountPesewas: number;
}

export interface DefaultAllocation {
  writtenOffPesewas: number;
  /** Loss covered by the merchant's withheld reserve. */
  fromReservePesewas: number;
  /** Loss clawed back from the merchant's future payouts (merchant_payable). */
  fromMerchantPesewas: number;
  /** Loss the platform absorbs from its default pool. */
  fromPoolPesewas: number;
}

/**
 * Allocates the loss when a plan defaults (ported from
 * docs/design/settlement-engine.ts, with the BNPL branch corrected to balance).
 *
 * Every model draws the plan's `reserve_held` first — that is the entire
 * purpose of withholding it. What differs is who covers the remainder:
 *
 *   - bnpl:        the platform, from `default_pool`. The merchant's exposure
 *                  is capped at the 5% reserve; the platform fronted the cash
 *                  and carries the rest of the risk.
 *   - hybrid/rto:  the merchant, from `merchant_payable` (driving it negative —
 *                  future payouts shrink until it clears). These models share
 *                  risk, which is why they withhold 7% and 12%.
 *   - layaway:     no accrual was ever booked (it pays out only at completion),
 *                  so there's nothing to write off at the settlement layer
 *
 * The loss is what the platform fronted that the customer has not repaid: the
 * receivable still open on the plan. Accruals book it as the merchant is
 * credited; `PlanCashLedger` retires it as the customer's cash arrives. It is
 * never more than the customer's unpaid balance, and it used to BE that
 * balance. The two agree for bnpl and rent_to_own, which credit the whole
 * order at approval. They do not for hybrid, which credits 40% at the deposit
 * and 60% at completion: a hybrid customer who paid the deposit and stopped
 * left a 60% balance nobody had ever been credited, and the merchant was
 * clawed for it — driven to −21,600 on a 100,000 order they had been paid
 * 35,600 for, and to −100,000 when the customer never paid the deposit and the
 * merchant had been paid nothing at all. The 60% a merchant never receives is
 * already their share of a hybrid default; charging it again made them carry
 * it twice.
 *
 * Every allocation is a single balanced transaction `default:{plan}` — the
 * receivable write-off (CREDIT) is matched by the debits that absorb it.
 * Idempotent: a replay finds the transaction already booked and no-ops.
 *
 * Cash-in retires the receivable only where `PlanCashLedger` is wired, as it is
 * in production. Without it — framework-free callers, some tests — the
 * receivable is never retired, the cap is the whole accrual, and the loss is
 * sized as before.
 */
export class DefaultService {
  constructor(
    private readonly db: Database,
    private readonly ledger: LedgerService,
    private readonly reserveRelease: ReserveReleaseService,
  ) {}

  async handleDefault(
    input: HandleDefaultInput,
    tx?: ReserveExecutor,
  ): Promise<DefaultAllocation | null> {
    const { customerPlanId, merchantId, model } = input;
    if (input.unrecoveredAmountPesewas <= 0) return null;
    // Layaway never accrues before completion, so a default has no settlement
    // footprint — forfeiture is handled outside the ledger.
    if (model === 'layaway') return null;

    const transactionId = `default:${customerPlanId}`;
    const exec: ReserveExecutor = tx ?? this.db;

    // Idempotency — a replay returns nothing without re-booking.
    const existing = await exec
      .select({ transaction_id: ledger.transaction_id })
      .from(ledger)
      .where(eq(ledger.transaction_id, transactionId))
      .limit(1);
    if (existing[0]) return null;

    // Ledger balances are credit-positive, so what is still owed on a
    // debit-normal receivable reads negative.
    const fronted = -(await this.ledger.balanceOf('receivable', customerPlanId, tx));
    const unrecoveredAmountPesewas = Math.min(input.unrecoveredAmountPesewas, Math.max(0, fronted));
    // Nothing fronted is unpaid: no loss to allocate, and the reserve stays
    // whole for the release clock `markPlanDefaulted` starts.
    if (unrecoveredAmountPesewas <= 0) return null;

    const metadata = { reason: 'default', model, customer_plan_id: customerPlanId };
    const entries: LedgerEntryInput[] = [
      {
        transactionId,
        accountType: 'receivable',
        accountRef: customerPlanId,
        direction: 'credit', // write off the receivable
        amountPesewas: unrecoveredAmountPesewas,
        description: 'Receivable written off on default',
        metadata,
      },
    ];

    let fromMerchant = 0;
    let fromPool = 0;

    // The reserve exists to absorb exactly this, so it goes first for every
    // model. BNPL used to skip it entirely and bill the platform pool for the
    // whole loss, which left the merchant's 5% withheld against a risk it was
    // never actually asked to cover.
    const reserveBalance = await this.ledger.balanceOf('reserve_held', customerPlanId, tx);
    const fromReserve = Math.min(Math.max(0, reserveBalance), unrecoveredAmountPesewas);
    const beyondReserve = unrecoveredAmountPesewas - fromReserve;

    if (fromReserve > 0) {
      entries.push({
        transactionId,
        accountType: 'reserve_held',
        accountRef: customerPlanId,
        direction: 'debit',
        amountPesewas: fromReserve,
        description: 'Reserve consumed for default',
        metadata,
      });
    }

    if (beyondReserve > 0) {
      if (model === 'bnpl') {
        // Merchant exposure is capped at the reserve; the platform fronted the
        // cash and carries everything past it.
        fromPool = beyondReserve;
        entries.push({
          transactionId,
          accountType: 'default_pool',
          accountRef: SETTLEMENT_CASH_REF,
          direction: 'debit',
          amountPesewas: fromPool,
          description: 'Default write-off absorbed by platform pool',
          metadata,
        });
      } else {
        // hybrid / rent_to_own share the risk — claw the rest from the merchant.
        fromMerchant = beyondReserve;
        entries.push({
          transactionId,
          accountType: 'merchant_payable',
          accountRef: merchantId,
          direction: 'debit',
          amountPesewas: fromMerchant,
          description: 'Default claw-back beyond reserve',
          metadata,
        });
      }
    }

    await this.ledger.record(entries, tx);

    // Keep the held_reserves bookkeeping in step with the reserve we just drew.
    if (fromReserve > 0) {
      await this.reserveRelease.consumeForDefault(customerPlanId, fromReserve, tx);
    }

    return {
      writtenOffPesewas: unrecoveredAmountPesewas,
      fromReservePesewas: fromReserve,
      fromMerchantPesewas: fromMerchant,
      fromPoolPesewas: fromPool,
    };
  }
}
