import {
  LedgerService,
  type LedgerEntryInput,
  type LedgerExecutor,
} from '../../shared/ledger/ledger.service';
import { PLATFORM_ACCOUNT_REF } from '../settlements/payout-recorder';

/** The single platform cash account reconciled against the provider's balance. */
export const PROVIDER_CASH_REF = 'main';

/**
 * Cash that never touched the provider — an out-of-band payment recorded by an
 * admin (a field agent's cash collection, a bank transfer). Segregated so that
 * `paystack_settlement['main']` continues to mean "what Paystack should be
 * holding for us", which is the entire premise of ledger-vs-provider
 * reconciliation. Booking manual cash to 'main' would poison exactly the
 * number the cash-in leg exists to make checkable.
 */
export const MANUAL_CASH_REF = 'manual';

export interface CollectInput {
  scheduleId: string;
  customerPlanId: string;
  /** Principal + interest + fees portion of this installment. */
  amountDuePesewas: number;
  /** Late fee collected on top, if any. Recognised immediately as revenue. */
  lateFeePesewas: number;
  /** Which cash account received it. */
  cashRef: string;
}

/**
 * Books the customer-side money movements for a plan.
 *
 * Before this existed the ledger had no inbound leg at all: a customer could
 * pay a plan in full and `paystack_settlement` would never be debited,
 * `receivable` never retired. The books could not answer "how much cash do we
 * hold" or "how much have customers repaid", so settlement could not be gated
 * on available funds and no reconciliation against the provider was possible.
 *
 * The waterfall exists because the merchant accrual fires at a different time
 * per business model (see migration 0008). Cash retires `receivable` only up
 * to what has actually been accrued; anything beyond that is held in
 * `customer_float` until an accrual claims it, or recognised as finance income
 * at completion.
 */
export class PlanCashLedger {
  constructor(private readonly ledger: LedgerService) {}

  /**
   * Applies one collected installment.
   *
   * `DEBIT paystack_settlement` is cash arriving (the opposite sign to
   * SettlementService's payout, which credits it as cash leaves).
   */
  async collect(input: CollectInput, tx: LedgerExecutor): Promise<void> {
    const transactionId = `collect:${input.scheduleId}`;
    if (await this.alreadyBooked(transactionId, tx)) return;

    const total = input.amountDuePesewas + input.lateFeePesewas;
    if (total <= 0) return;

    // Retire only what is genuinely owed to us right now. `balanceOf` is
    // credits - credits, so an amount owed shows as a negative balance.
    const owed = -(await this.ledger.balanceOf('receivable', input.customerPlanId, tx));
    const toReceivable = Math.max(0, Math.min(input.amountDuePesewas, owed));
    const toFloat = input.amountDuePesewas - toReceivable;

    const metadata = { schedule_id: input.scheduleId, plan_id: input.customerPlanId };
    const entries: LedgerEntryInput[] = [
      {
        transactionId,
        accountType: 'paystack_settlement' as const,
        accountRef: input.cashRef,
        direction: 'debit' as const,
        amountPesewas: total,
        description: 'Installment collected',
        metadata,
      },
      {
        transactionId,
        accountType: 'receivable' as const,
        accountRef: input.customerPlanId,
        direction: 'credit' as const,
        amountPesewas: toReceivable,
        description: 'Retire receivable on collection',
        metadata,
      },
      {
        transactionId,
        accountType: 'customer_float' as const,
        accountRef: input.customerPlanId,
        direction: 'credit' as const,
        amountPesewas: toFloat,
        description: 'Collected ahead of merchant accrual',
        metadata,
      },
      {
        transactionId,
        accountType: 'revenue' as const,
        accountRef: PLATFORM_ACCOUNT_REF,
        direction: 'credit' as const,
        amountPesewas: input.lateFeePesewas,
        description: 'Late fee collected',
        metadata,
      },
    ].filter((e) => e.amountPesewas > 0); // the ledger rejects zero-amount rows

    await this.ledger.record(entries, tx);
  }

  /**
   * Sweeps held float into `receivable` after an accrual has recognised new
   * debt. Called once per accrual: without it, a layaway plan would end with
   * cash sitting in float and a fully-unretired receivable, both permanently
   * wrong in an append-only ledger.
   */
  async sweepFloatToReceivable(
    customerPlanId: string,
    sweepKey: string,
    tx: LedgerExecutor,
  ): Promise<void> {
    const transactionId = `float-sweep:${customerPlanId}:${sweepKey}`;
    if (await this.alreadyBooked(transactionId, tx)) return;

    const held = await this.ledger.balanceOf('customer_float', customerPlanId, tx);
    const owed = -(await this.ledger.balanceOf('receivable', customerPlanId, tx));
    const amount = Math.min(Math.max(0, held), Math.max(0, owed));
    if (amount <= 0) return;

    await this.ledger.record(
      [
        {
          transactionId,
          accountType: 'customer_float',
          accountRef: customerPlanId,
          direction: 'debit',
          amountPesewas: amount,
          description: 'Apply held cash to accrued receivable',
          metadata: { plan_id: customerPlanId, sweep: sweepKey },
        },
        {
          transactionId,
          accountType: 'receivable',
          accountRef: customerPlanId,
          direction: 'credit',
          amountPesewas: amount,
          description: 'Receivable retired from held cash',
          metadata: { plan_id: customerPlanId, sweep: sweepKey },
        },
      ],
      tx,
    );
  }

  /**
   * Recognises whatever float remains once a plan completes as finance income.
   *
   * Collections total `order + interest + fees`, but an accrual only ever
   * debits `receivable` by the order amount. The difference is the platform's
   * interest and service fees, and without this it would sit in float forever
   * — a permanent, unexplainable residue on an append-only table.
   */
  async recogniseFinanceIncome(customerPlanId: string, tx: LedgerExecutor): Promise<void> {
    const transactionId = `finance-income:${customerPlanId}`;
    if (await this.alreadyBooked(transactionId, tx)) return;

    const held = await this.ledger.balanceOf('customer_float', customerPlanId, tx);
    if (held <= 0) return;

    await this.ledger.record(
      [
        {
          transactionId,
          accountType: 'customer_float',
          accountRef: customerPlanId,
          direction: 'debit',
          amountPesewas: held,
          description: 'Release float at plan completion',
          metadata: { plan_id: customerPlanId },
        },
        {
          transactionId,
          accountType: 'revenue',
          accountRef: PLATFORM_ACCOUNT_REF,
          direction: 'credit',
          amountPesewas: held,
          description: 'Finance income (interest and fees) on completed plan',
          metadata: { plan_id: customerPlanId },
        },
      ],
      tx,
    );
  }

  /**
   * Reverses the cash leg of a refunded installment.
   *
   * `reverseAccrualsForRefund` already credits `receivable` to claw the accrual
   * back from the merchant. Without this, the collection's own credit is never
   * undone and one installment releases `receivable` twice, understating what
   * the customer still owes. The obligation lands in `refund_payable` — an
   * account the schema has always defined and nothing has ever written — and
   * stays there until the money physically returns (S7).
   */
  async reverseCollection(
    input: {
      scheduleId: string;
      customerPlanId: string;
      /** The instalment's own amount being handed back — not its late fee. */
      amountPesewas: number;
      /**
       * The late fee paid on it, handed back too. `collect` booked the fee to
       * `revenue`, so that is where it comes back from. It used to be folded
       * into `amountPesewas` and re-opened as debt the customer owed, while the
       * platform kept the fee as revenue and the seller's clawback covered it.
       */
      lateFeePesewas?: number;
    },
    tx: LedgerExecutor,
  ): Promise<void> {
    const lateFee = Math.max(0, input.lateFeePesewas ?? 0);
    if (input.amountPesewas + lateFee <= 0) return;
    const transactionId = `refund-cash:${input.scheduleId}`;
    if (await this.alreadyBooked(transactionId, tx)) return;

    // Debit wherever the cash currently sits, which is not necessarily where
    // the collection first put it: a later accrual and its sweep may have moved
    // it from float into receivable. Inverting the original collection would
    // then debit an empty float and drive it negative. Float first, receivable
    // for the remainder — the collect waterfall run backwards.
    //
    // This runs after reverseAccrualsForRefund, which has already released the
    // merchant's side by crediting receivable; without this leg that credit
    // stands alone and one refund releases receivable twice.
    const heldInFloat = Math.max(
      0,
      await this.ledger.balanceOf('customer_float', input.customerPlanId, tx),
    );
    const fromFloat = Math.min(input.amountPesewas, heldInFloat);
    const fromReceivable = input.amountPesewas - fromFloat;

    const metadata = { schedule_id: input.scheduleId, plan_id: input.customerPlanId };
    await this.ledger.record(
      [
        {
          transactionId,
          accountType: 'customer_float' as const,
          accountRef: input.customerPlanId,
          direction: 'debit' as const,
          amountPesewas: fromFloat,
          description: 'Release held cash for refunded installment',
          metadata,
        },
        {
          transactionId,
          accountType: 'receivable' as const,
          accountRef: input.customerPlanId,
          direction: 'debit' as const,
          amountPesewas: fromReceivable,
          description: 'Re-open receivable for refunded installment',
          metadata,
        },
        {
          transactionId,
          accountType: 'revenue' as const,
          accountRef: PLATFORM_ACCOUNT_REF,
          direction: 'debit' as const,
          amountPesewas: lateFee,
          description: 'Late fee handed back with refunded installment',
          metadata,
        },
        {
          transactionId,
          // The cash has not physically moved yet — it is still in the provider
          // account. This records the obligation; S7 discharges it with
          // DEBIT refund_payable / CREDIT paystack_settlement.
          accountType: 'refund_payable' as const,
          accountRef: input.customerPlanId,
          direction: 'credit' as const,
          amountPesewas: input.amountPesewas + lateFee,
          description: 'Owed back to customer',
          metadata,
        },
      ].filter((e) => e.amountPesewas > 0),
      tx,
    );
  }

  /** Deterministic transaction ids make every leg replay-safe. */
  private async alreadyBooked(transactionId: string, tx: LedgerExecutor): Promise<boolean> {
    return this.ledger.transactionExists(transactionId, tx);
  }
}
