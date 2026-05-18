// ============================================================================
// settlement-engine.ts
// ----------------------------------------------------------------------------
// Merchant settlement, reserve management, and payout orchestration.
//
// Core invariants:
//   1. Double-entry accounting: every cedi has a source and destination
//   2. Money is stored as integer pesewas (GHS × 100) — never floats
//   3. All payout math is deterministic given the inputs (auditable)
//   4. Settlement is idempotent — re-running for a date never double-pays
//   5. Reserves are released by policy, not by ad-hoc decision
// ============================================================================

import { Injectable, Logger } from '@nestjs/common';
import Decimal from 'decimal.js';

// ---------------------------------------------------------------------------
// 1. BUSINESS MODEL CONFIGURATION
// ---------------------------------------------------------------------------

export type BusinessModel = 'bnpl' | 'layaway' | 'hybrid' | 'rent_to_own';

interface ModelConfig {
  /** When does the merchant first receive money? */
  payoutTrigger: 'order_approved' | 'down_payment_received' | 'plan_completed';

  /** How is the order amount split across payouts? */
  payoutSplits: PayoutSplit[];

  /** Merchant Discount Rate — basis points (400 = 4%) */
  mdrBps: number;

  /** Reserve hold — basis points of order value */
  reserveBps: number;

  /** When can reserve be released? */
  reserveReleasePolicy: ReleasePolicy;
}

interface PayoutSplit {
  trigger: 'order_approved' | 'down_payment_received' | 'installment_n' | 'plan_completed';
  installmentNumber?: number; // for 'installment_n'
  percentOfOrder: number;     // 0..1
}

type ReleasePolicy =
  | { type: 'after_plan_completion'; bufferDays: number }
  | { type: 'after_delivery'; bufferDays: number }
  | { type: 'rolling_monthly'; months: number };

export const MODEL_CONFIG: Record<BusinessModel, ModelConfig> = {
  bnpl: {
    payoutTrigger: 'order_approved',
    payoutSplits: [
      { trigger: 'order_approved', percentOfOrder: 1.0 }, // full amount upfront
    ],
    mdrBps: 400,        // 4%
    reserveBps: 500,    // 5%
    reserveReleasePolicy: { type: 'after_plan_completion', bufferDays: 14 },
  },
  layaway: {
    payoutTrigger: 'plan_completed',
    payoutSplits: [
      { trigger: 'plan_completed', percentOfOrder: 1.0 },
    ],
    mdrBps: 300,        // 3% service fee
    reserveBps: 200,    // 2% (low — platform never held the cash)
    reserveReleasePolicy: { type: 'after_delivery', bufferDays: 7 },
  },
  hybrid: {
    payoutTrigger: 'down_payment_received',
    payoutSplits: [
      { trigger: 'down_payment_received', percentOfOrder: 0.40 },
      { trigger: 'plan_completed', percentOfOrder: 0.60 },
    ],
    mdrBps: 400,
    reserveBps: 700,    // 7% — split risk
    reserveReleasePolicy: { type: 'after_plan_completion', bufferDays: 14 },
  },
  rent_to_own: {
    payoutTrigger: 'order_approved',
    payoutSplits: [
      { trigger: 'order_approved', percentOfOrder: 1.0 },
    ],
    mdrBps: 500,        // 5% — long-tail risk
    reserveBps: 1200,   // 12% — highest reserve
    reserveReleasePolicy: { type: 'rolling_monthly', months: 12 },
  },
};

// ---------------------------------------------------------------------------
// 2. PAYOUT CALCULATION — pure math, fully testable
// ---------------------------------------------------------------------------

export interface PayoutBreakdown {
  /** Gross amount this payout is based on (in pesewas) */
  gross: number;
  /** MDR deducted */
  mdr: number;
  /** Reserve withheld */
  reserve: number;
  /** Net amount to send to merchant */
  net: number;
  /** Platform's revenue from this payout */
  platformRevenue: number;
}

export class PayoutCalculator {
  /**
   * Calculate merchant payout for a specific trigger event.
   * Pure function — no I/O. Easy to test exhaustively.
   */
  static calculate(
    orderAmountPesewas: number,
    model: BusinessModel,
    trigger: PayoutSplit['trigger'],
  ): PayoutBreakdown | null {
    const config = MODEL_CONFIG[model];
    const split = config.payoutSplits.find((s) => s.trigger === trigger);
    if (!split) return null;

    // Use Decimal for intermediate math; round to pesewas at the end
    const grossDec = new Decimal(orderAmountPesewas).mul(split.percentOfOrder);
    const gross = grossDec.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();

    const mdr = new Decimal(gross)
      .mul(config.mdrBps)
      .div(10000)
      .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
      .toNumber();

    const reserve = new Decimal(gross)
      .mul(config.reserveBps)
      .div(10000)
      .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
      .toNumber();

    const net = gross - mdr - reserve;

    return {
      gross,
      mdr,
      reserve,
      net,
      platformRevenue: mdr, // reserve isn't revenue — it's a liability we may return
    };
  }
}

// ---------------------------------------------------------------------------
// 3. DOUBLE-ENTRY LEDGER — every movement creates two entries
// ---------------------------------------------------------------------------

export type AccountType =
  | 'paystack_settlement'   // your bank account (Asset)
  | 'merchant_payable'      // owed to merchants (Liability)
  | 'reserve_held'          // reserve withheld from merchant (Liability)
  | 'default_pool'          // funded from reserves (Asset)
  | 'revenue'               // platform earnings (Income)
  | 'receivable'            // owed by customer (Asset)
  | 'refund_payable';       // pending customer refunds (Liability)

export interface LedgerEntry {
  id: string;
  transactionId: string;    // groups debit+credit pair(s)
  accountType: AccountType;
  accountRef: string;       // e.g. merchant_id for merchant_payable
  direction: 'debit' | 'credit';
  amount: number;           // pesewas, always positive
  currency: 'GHS';
  description: string;
  metadata: Record<string, unknown>;
  occurredAt: Date;
}

@Injectable()
export class LedgerService {
  /**
   * Records a balanced transaction (sum of debits = sum of credits).
   * Throws if unbalanced — single most important invariant.
   */
  async record(
    entries: Omit<LedgerEntry, 'id' | 'occurredAt'>[],
  ): Promise<string> {
    const debits = entries
      .filter((e) => e.direction === 'debit')
      .reduce((sum, e) => sum + e.amount, 0);
    const credits = entries
      .filter((e) => e.direction === 'credit')
      .reduce((sum, e) => sum + e.amount, 0);

    if (debits !== credits) {
      throw new Error(
        `Unbalanced transaction: debits=${debits} credits=${credits}`,
      );
    }

    // Single DB transaction inserting all entries — atomic
    return this.persistAtomically(entries);
  }

  /** Account balance = sum(credits) – sum(debits) for liability/income accounts */
  async balanceOf(
    accountType: AccountType,
    accountRef: string,
  ): Promise<number> {
    // SELECT sum(amount * CASE direction WHEN 'credit' THEN 1 ELSE -1 END)
    // FROM ledger_entries WHERE account_type = ? AND account_ref = ?
    return 0; // stub
  }

  private async persistAtomically(entries: any[]): Promise<string> {
    return ''; // stub — wraps INSERT INTO ledger_entries in a tx
  }
}

// ---------------------------------------------------------------------------
// 4. PAYOUT RECORDING — when a payout becomes eligible
// ---------------------------------------------------------------------------

@Injectable()
export class PayoutRecorder {
  constructor(private readonly ledger: LedgerService) {}

  /**
   * Called when a payout-triggering event happens (order approved, down
   * payment received, plan completed). Books the entries, doesn't move
   * actual money — the settlement worker does that in batches.
   */
  async recordPayoutAccrual(args: {
    customerPlanId: string;
    merchantId: string;
    orderAmount: number;
    model: BusinessModel;
    trigger: PayoutSplit['trigger'];
  }): Promise<PayoutBreakdown | null> {
    const breakdown = PayoutCalculator.calculate(
      args.orderAmount,
      args.model,
      args.trigger,
    );
    if (!breakdown) return null;

    const transactionId = `accrue:${args.customerPlanId}:${args.trigger}`;

    // BNPL example for trigger="order_approved":
    //   We've credited the customer (they owe us the receivable).
    //   We owe the merchant their net.
    //   We owe ourselves reserve and revenue.
    await this.ledger.record([
      {
        transactionId,
        accountType: 'receivable',
        accountRef: args.customerPlanId,
        direction: 'debit',          // we are owed
        amount: breakdown.gross,
        currency: 'GHS',
        description: `Receivable for plan ${args.customerPlanId}`,
        metadata: { trigger: args.trigger },
      },
      {
        transactionId,
        accountType: 'merchant_payable',
        accountRef: args.merchantId,
        direction: 'credit',         // we owe them
        amount: breakdown.net,
        currency: 'GHS',
        description: `Net payout owed to merchant`,
        metadata: { customerPlanId: args.customerPlanId },
      },
      {
        transactionId,
        accountType: 'reserve_held',
        accountRef: args.merchantId,
        direction: 'credit',         // we hold reserve as liability
        amount: breakdown.reserve,
        currency: 'GHS',
        description: `Reserve withheld`,
        metadata: { customerPlanId: args.customerPlanId },
      },
      {
        transactionId,
        accountType: 'revenue',
        accountRef: 'platform',
        direction: 'credit',
        amount: breakdown.mdr,
        currency: 'GHS',
        description: `MDR earned`,
        metadata: { customerPlanId: args.customerPlanId },
      },
    ]);

    return breakdown;
  }
}

// ---------------------------------------------------------------------------
// 5. SETTLEMENT WORKER — runs daily, executes actual transfers
// ---------------------------------------------------------------------------

@Injectable()
export class SettlementWorker {
  private readonly logger = new Logger(SettlementWorker.name);

  /** Minimum payout amount to avoid Paystack transfer fees on dust */
  private readonly MIN_PAYOUT_PESEWAS = 10_000; // GHS 100

  constructor(
    private readonly ledger: LedgerService,
    private readonly paystack: PaystackClient,
    private readonly merchants: MerchantRepository,
    private readonly payouts: PayoutRepository,
  ) {}

  /**
   * Runs once per day. For each active merchant, calculates net payable
   * and issues a transfer if it clears the threshold.
   */
  async runDailySettlement(asOf: Date): Promise<void> {
    const merchants = await this.merchants.findAllActive();

    for (const merchant of merchants) {
      try {
        await this.settleMerchant(merchant, asOf);
      } catch (err) {
        this.logger.error(
          `Settlement failed for merchant ${merchant.id}`,
          err,
        );
        // Continue with others — one merchant failing doesn't stop the batch
      }
    }
  }

  private async settleMerchant(merchant: Merchant, asOf: Date): Promise<void> {
    // 1. Idempotency: have we already settled this merchant today?
    const existing = await this.payouts.findByMerchantAndDate(
      merchant.id,
      asOf,
    );
    if (existing && existing.status !== 'failed') {
      this.logger.log(
        `Merchant ${merchant.id} already settled for ${asOf.toISOString()}`,
      );
      return;
    }

    // 2. Compute net payable from ledger
    const grossPayable = await this.ledger.balanceOf(
      'merchant_payable',
      merchant.id,
    );

    // 3. Apply reserve releases that have matured
    const reserveReleases = await this.processReserveReleases(
      merchant.id,
      asOf,
    );

    // 4. Apply pending chargebacks/refunds
    const chargebackDebits = await this.computeChargebackDebits(merchant.id);

    const netPayable = grossPayable + reserveReleases - chargebackDebits;

    if (netPayable < this.MIN_PAYOUT_PESEWAS) {
      this.logger.log(
        `Merchant ${merchant.id} below threshold (${netPayable} pesewas) — rolling forward`,
      );
      return;
    }

    // 5. Record payout intent BEFORE calling Paystack
    const payoutId = await this.payouts.create({
      merchantId: merchant.id,
      amount: netPayable,
      asOf,
      status: 'initiated',
      reference: `PAYOUT:${merchant.id}:${asOf.toISOString().slice(0, 10)}`,
    });

    // 6. Book ledger entries — debit merchant_payable, credit settlement
    await this.ledger.record([
      {
        transactionId: `settle:${payoutId}`,
        accountType: 'merchant_payable',
        accountRef: merchant.id,
        direction: 'debit',           // we're paying down what we owe
        amount: netPayable,
        currency: 'GHS',
        description: `Daily settlement ${asOf.toISOString().slice(0, 10)}`,
        metadata: { payoutId },
      },
      {
        transactionId: `settle:${payoutId}`,
        accountType: 'paystack_settlement',
        accountRef: 'main',
        direction: 'credit',          // outflow from our account
        amount: netPayable,
        currency: 'GHS',
        description: `Transfer to merchant ${merchant.id}`,
        metadata: { payoutId },
      },
    ]);

    // 7. Call Paystack Transfer API (idempotent via reference)
    try {
      const transfer = await this.paystack.initiateTransfer({
        source: 'balance',
        amount: netPayable,
        recipient: merchant.paystackRecipientCode,
        reason: `Settlement ${asOf.toISOString().slice(0, 10)}`,
        reference: `PAYOUT:${merchant.id}:${asOf.toISOString().slice(0, 10)}`,
      });

      await this.payouts.update(payoutId, {
        paystackTransferCode: transfer.data.transfer_code,
        status: 'pending_confirmation',
      });
    } catch (err: any) {
      // Don't rollback the ledger — the transfer may still process.
      // Reconciliation worker will resolve via Paystack /transfer/verify.
      this.logger.error(`Transfer call failed for payout ${payoutId}`, err);
      await this.payouts.update(payoutId, {
        status: 'unknown',
        lastError: err.message,
      });
    }
  }

  // -------------------------------------------------------------------------
  // RESERVE RELEASE LOGIC
  // -------------------------------------------------------------------------
  private async processReserveReleases(
    merchantId: string,
    asOf: Date,
  ): Promise<number> {
    const heldReserves = await this.payouts.findHeldReserves(merchantId);
    let totalReleased = 0;

    for (const r of heldReserves) {
      const releaseDate = this.computeReleaseDate(r, asOf);
      if (releaseDate > asOf) continue; // not yet matured

      const releaseAmount = this.computeReleaseAmount(r, asOf);

      await this.ledger.record([
        {
          transactionId: `release:${r.id}`,
          accountType: 'reserve_held',
          accountRef: merchantId,
          direction: 'debit',           // reduce our reserve liability
          amount: releaseAmount,
          currency: 'GHS',
          description: `Reserve release for plan ${r.customerPlanId}`,
          metadata: { reserveId: r.id },
        },
        {
          transactionId: `release:${r.id}`,
          accountType: 'merchant_payable',
          accountRef: merchantId,
          direction: 'credit',          // increase what we owe merchant
          amount: releaseAmount,
          currency: 'GHS',
          description: `Reserve released to merchant`,
          metadata: { reserveId: r.id },
        },
      ]);

      totalReleased += releaseAmount;
      await this.payouts.markReserveReleased(r.id, releaseAmount, asOf);
    }

    return totalReleased;
  }

  private computeReleaseDate(reserve: HeldReserve, asOf: Date): Date {
    const policy = MODEL_CONFIG[reserve.model].reserveReleasePolicy;
    switch (policy.type) {
      case 'after_plan_completion':
        if (!reserve.planCompletedAt) return new Date(8640000000000000); // never
        return addDays(reserve.planCompletedAt, policy.bufferDays);

      case 'after_delivery':
        if (!reserve.deliveredAt) return new Date(8640000000000000);
        return addDays(reserve.deliveredAt, policy.bufferDays);

      case 'rolling_monthly':
        // Released proportionally each month
        return reserve.heldAt;
    }
  }

  private computeReleaseAmount(reserve: HeldReserve, asOf: Date): number {
    const policy = MODEL_CONFIG[reserve.model].reserveReleasePolicy;
    if (policy.type !== 'rolling_monthly') {
      // Full release
      return reserve.amount - reserve.releasedAmount;
    }

    // Rolling: release 1/N each month
    const monthsElapsed = Math.floor(
      (asOf.getTime() - reserve.heldAt.getTime()) / (30 * 24 * 60 * 60 * 1000),
    );
    const monthsToRelease = Math.min(monthsElapsed, policy.months) -
      Math.floor(reserve.releasedAmount / (reserve.amount / policy.months));

    if (monthsToRelease <= 0) return 0;

    const perMonth = Math.floor(reserve.amount / policy.months);
    return perMonth * monthsToRelease;
  }

  // -------------------------------------------------------------------------
  // CHARGEBACK / DEFAULT DEDUCTIONS
  // -------------------------------------------------------------------------
  private async computeChargebackDebits(merchantId: string): Promise<number> {
    // Returns sum of unrecovered chargebacks/refunds.
    // These get deducted from the merchant's next payout.
    return 0; // stub
  }

  /**
   * Called when a customer plan defaults. Debits reserve first, then
   * falls back to clawing from future merchant payouts.
   */
  async handleDefault(args: {
    customerPlanId: string;
    merchantId: string;
    unrecoveredAmount: number;
    model: BusinessModel;
  }): Promise<void> {
    // Only certain models share default risk with merchants.
    // Pure BNPL: platform absorbs (it fronted the cash).
    // Layaway: no platform exposure — refund customer minus admin fee.
    // Hybrid / RTO: split per contract — clawed from reserve first.

    if (args.model === 'bnpl') {
      // Platform absorbs from default_pool
      await this.ledger.record([
        {
          transactionId: `default:${args.customerPlanId}`,
          accountType: 'default_pool',
          accountRef: 'main',
          direction: 'credit',          // pool funds the write-off
          amount: args.unrecoveredAmount,
          currency: 'GHS',
          description: `Default write-off`,
          metadata: { customerPlanId: args.customerPlanId },
        },
        {
          transactionId: `default:${args.customerPlanId}`,
          accountType: 'receivable',
          accountRef: args.customerPlanId,
          direction: 'credit',          // write off the receivable
          amount: args.unrecoveredAmount,
          currency: 'GHS',
          description: `Receivable written off`,
          metadata: { reason: 'default' },
        },
      ]);
      return;
    }

    // Hybrid / RTO: claw from reserve first
    const reserveBalance = await this.ledger.balanceOf(
      'reserve_held',
      args.merchantId,
    );
    const fromReserve = Math.min(reserveBalance, args.unrecoveredAmount);
    const fromMerchant = args.unrecoveredAmount - fromReserve;

    const entries: any[] = [
      {
        transactionId: `default:${args.customerPlanId}`,
        accountType: 'receivable',
        accountRef: args.customerPlanId,
        direction: 'credit',
        amount: args.unrecoveredAmount,
        currency: 'GHS',
        description: `Receivable written off`,
        metadata: { reason: 'default' },
      },
    ];

    if (fromReserve > 0) {
      entries.push({
        transactionId: `default:${args.customerPlanId}`,
        accountType: 'reserve_held',
        accountRef: args.merchantId,
        direction: 'debit',
        amount: fromReserve,
        currency: 'GHS',
        description: `Reserve consumed for default`,
        metadata: { customerPlanId: args.customerPlanId },
      });
    }

    if (fromMerchant > 0) {
      // Debit merchant_payable — future payouts shrink until this clears
      entries.push({
        transactionId: `default:${args.customerPlanId}`,
        accountType: 'merchant_payable',
        accountRef: args.merchantId,
        direction: 'debit',
        amount: fromMerchant,
        currency: 'GHS',
        description: `Default claw-back beyond reserve`,
        metadata: { customerPlanId: args.customerPlanId },
      });
    }

    await this.ledger.record(entries);
  }
}

// ---------------------------------------------------------------------------
// 6. UNIT TESTS (sketches)
// ---------------------------------------------------------------------------

/*
describe('PayoutCalculator', () => {
  it('BNPL: full payout on order_approved minus MDR & reserve', () => {
    const result = PayoutCalculator.calculate(100_000, 'bnpl', 'order_approved');
    expect(result).toEqual({
      gross: 100_000,
      mdr: 4_000,           // 4%
      reserve: 5_000,       // 5%
      net: 91_000,          // 91%
      platformRevenue: 4_000,
    });
  });

  it('Hybrid: 40% on down_payment, 60% on completion', () => {
    const dp = PayoutCalculator.calculate(100_000, 'hybrid', 'down_payment_received');
    expect(dp?.gross).toBe(40_000);
    expect(dp?.net).toBe(40_000 - 1_600 - 2_800); // - MDR - reserve

    const final = PayoutCalculator.calculate(100_000, 'hybrid', 'plan_completed');
    expect(final?.gross).toBe(60_000);
  });

  it('returns null for invalid trigger', () => {
    expect(PayoutCalculator.calculate(100_000, 'bnpl', 'plan_completed')).toBeNull();
  });
});

describe('LedgerService', () => {
  it('rejects unbalanced transactions', async () => {
    await expect(ledger.record([
      { direction: 'debit', amount: 100, ... },
      { direction: 'credit', amount: 90, ... },
    ])).rejects.toThrow('Unbalanced');
  });
});
*/

// ---------------------------------------------------------------------------
// TYPE STUBS
// ---------------------------------------------------------------------------

interface Merchant {
  id: string;
  paystackRecipientCode: string;
}

interface HeldReserve {
  id: string;
  customerPlanId: string;
  model: BusinessModel;
  amount: number;
  releasedAmount: number;
  heldAt: Date;
  planCompletedAt: Date | null;
  deliveredAt: Date | null;
}

declare class PaystackClient {
  initiateTransfer(req: any): Promise<any>;
}

declare class MerchantRepository {
  findAllActive(): Promise<Merchant[]>;
}

declare class PayoutRepository {
  findByMerchantAndDate(merchantId: string, asOf: Date): Promise<any>;
  findHeldReserves(merchantId: string): Promise<HeldReserve[]>;
  create(args: any): Promise<string>;
  update(id: string, patch: any): Promise<void>;
  markReserveReleased(id: string, amount: number, at: Date): Promise<void>;
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}
