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
  /** The customer balance we won't recover (pesewas). */
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
 * Every allocation is a single balanced transaction `default:{plan}` — the
 * receivable write-off (CREDIT) is matched by the debits that absorb it.
 * Idempotent: a replay finds the transaction already booked and no-ops.
 *
 * NOTE: customer cash-in isn't booked to the ledger in this system, so the
 * receivable account isn't fully reconciled by this write-off — it records the
 * loss allocation, which is what settlement cares about.
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
    const { customerPlanId, merchantId, model, unrecoveredAmountPesewas } = input;
    if (unrecoveredAmountPesewas <= 0) return null;
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
