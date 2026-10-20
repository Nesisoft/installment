import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createTestDb, schema } from '@installment/db';
import { AuditLogger } from '../audit/audit-logger.service';
import { SYSTEM_ACTORS } from '../../shared/constants/system-actors';
import { LedgerService, type LedgerEntryInput } from '../../shared/ledger/ledger.service';
import { runInTransaction } from '../../shared/event-bus/transaction';
import { MerchantsService } from '../merchants/merchants.service';
import { CustomersService } from '../customers/customers.service';
import { MockGhanaCardVerifier } from '../customers/ghana-card-verifier';
import { PlanTemplatesService } from '../plans/plan-templates.service';
import { ApplicationsService } from '../applications/applications.service';
import { CustomerPlansService } from '../schedules/customer-plans.service';
import { PlanCashLedger } from '../schedules/plan-cash-ledger';
import { PayoutRecorder } from '../settlements/payout-recorder';
import { ReserveReleaseService } from '../settlements/reserve-release.service';
import { DefaultService } from '../settlements/default.service';
import {
  SETTLEMENT_CASH_REF,
  SettlementService,
  type PayoutTransferClient,
} from '../settlements/settlement.service';
import { CollectionsService } from '../collections/collections.service';
import { MerchantDashboardService } from '../settlements/merchant-dashboard.service';
import { MoneyRepairError, MoneyRepairsService } from './money-repairs.service';

const RUN_DB = Boolean(process.env.DATABASE_URL);

/**
 * The repairs, against the states the old code actually left behind.
 *
 * Each bad state is produced the way production produced it: a default booked
 * with the pre-#114 sizing, a `transfer.reversed` stored and ignored, a case
 * closed over an unpaid instalment. The fixed code can no longer produce any of
 * them, so the helpers below write them the way the old code did.
 */
describe.skipIf(!RUN_DB)('money repairs (integration)', () => {
  const { db, pool } = createTestDb();
  const audit = new AuditLogger();
  const ledger = new LedgerService(db);
  const payouts = new PayoutRecorder(db, ledger);
  const reserves = new ReserveReleaseService(db, ledger);
  const defaults = new DefaultService(db, ledger, reserves);
  const merchants = new MerchantsService(db, audit);
  const customers = new CustomersService(db, audit, new MockGhanaCardVerifier());
  const planTemplates = new PlanTemplatesService(db, audit);
  const apps = new ApplicationsService(db, audit);
  // Wired as production wires it: cash retires the receivable.
  const plans = new CustomerPlansService(
    db,
    audit,
    undefined,
    payouts,
    reserves,
    defaults,
    new PlanCashLedger(ledger),
  );
  const succeeding: PayoutTransferClient = {
    async initiateTransfer(req) {
      return {
        data: {
          transfer_code: `TRF_${req.reference}`,
          reference: req.reference,
          status: 'success',
        },
      };
    },
  };
  const settlement = new SettlementService(db, ledger, audit, succeeding);
  const repairs = new MoneyRepairsService(
    db,
    ledger,
    audit,
    settlement,
    new PlanCashLedger(ledger),
  );
  const ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  const templates = {} as Record<'hybrid' | 'rtoInterest' | 'bnplInterest' | 'bnpl', string>;

  beforeAll(async () => {
    const s = randomUUID();
    const make = async (
      key: keyof typeof templates,
      model: 'bnpl' | 'hybrid' | 'rent_to_own',
      extra: Record<string, number>,
    ) => {
      templates[key] = (
        await planTemplates.create(
          {
            name: `Repair ${key} ${s}`,
            business_model: model,
            number_of_installments: 4,
            installment_frequency_days: 30,
            min_amount_pesewas: 1_000,
            max_amount_pesewas: 10_000_000,
            ...extra,
          },
          ACTOR,
        )
      ).id;
    };
    await make('hybrid', 'hybrid', { down_payment_bps: 4_000, number_of_installments: 3 });
    await make('rtoInterest', 'rent_to_own', { interest_rate_bps: 1_000 });
    await make('bnplInterest', 'bnpl', { interest_rate_bps: 1_000 });
    await make('bnpl', 'bnpl', {});
  });

  afterAll(async () => {
    await pool.end();
  });

  async function freshMerchant(): Promise<string> {
    const s = randomUUID();
    const m = await merchants.create(
      {
        business_name: `Repair ${s}`,
        legal_name: `Repair Ltd ${s}`,
        email: `repair+${s}@x.gh`,
        phone: '+233244000000',
      },
      ACTOR,
    );
    return m.id;
  }

  async function activate(template: keyof typeof templates, merchantId: string) {
    const s = randomUUID();
    const customer = await customers.register(
      {
        first_name: 'Repair',
        last_name: 'Case',
        email: `rc+${s}@x.gh`,
        phone: `024${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
      },
      ACTOR,
    );
    const app = await apps.submit(
      {
        customer_id: customer.id,
        merchant_id: merchantId,
        plan_template_id: templates[template],
        order_reference: `ORD-${randomUUID()}`,
        order_amount_pesewas: 100_000,
        merchant_category: 'electronics',
      },
      ACTOR,
    );
    await apps.recordDecision(app.id, { outcome: 'approved' }, ACTOR);
    return plans.activateFromApplication(app.id, ACTOR);
  }

  /**
   * A default booked the way `DefaultService` booked it before #114: the loss
   * is the customer's whole unpaid balance, whatever had been fronted.
   */
  async function bookPre114Default(planId: string): Promise<void> {
    await runInTransaction(db, async (tx) => {
      const plan = (
        await tx.select().from(schema.customer_plans).where(eq(schema.customer_plans.id, planId))
      )[0]!;
      const unrecovered = plan.outstanding_pesewas;
      const reserve = await ledger.balanceOf('reserve_held', planId, tx);
      const fromReserve = Math.min(Math.max(0, reserve), unrecovered);
      const beyond = unrecovered - fromReserve;
      const txn = `default:${planId}`;
      const entries: LedgerEntryInput[] = [
        {
          transactionId: txn,
          accountType: 'receivable',
          accountRef: planId,
          direction: 'credit',
          amountPesewas: unrecovered,
          description: 'Receivable written off on default',
        },
        {
          transactionId: txn,
          accountType: 'reserve_held',
          accountRef: planId,
          direction: 'debit',
          amountPesewas: fromReserve,
          description: 'Reserve consumed for default',
        },
        plan.business_model === 'bnpl'
          ? {
              transactionId: txn,
              accountType: 'default_pool',
              accountRef: SETTLEMENT_CASH_REF,
              direction: 'debit',
              amountPesewas: beyond,
              description: 'Default write-off absorbed by platform pool',
            }
          : {
              transactionId: txn,
              accountType: 'merchant_payable',
              accountRef: plan.merchant_id,
              direction: 'debit',
              amountPesewas: beyond,
              description: 'Default claw-back beyond reserve',
            },
      ];
      await ledger.record(
        entries.filter((e) => e.amountPesewas > 0),
        tx,
      );
      if (fromReserve > 0) await reserves.consumeForDefault(planId, fromReserve, tx);
      const now = new Date();
      await tx
        .update(schema.customer_plans)
        .set({ status: 'defaulted', defaulted_at: now.toISOString() })
        .where(eq(schema.customer_plans.id, planId));
      await reserves.markPlanDefaulted(planId, now, tx);
    });
  }

  async function transactionBalances(transactionId: string): Promise<boolean> {
    const rows = await db
      .select()
      .from(schema.ledger_entries)
      .where(eq(schema.ledger_entries.transaction_id, transactionId));
    const sum = (d: string) =>
      rows.filter((r) => r.direction === d).reduce((n, r) => n + r.amount_pesewas, 0);
    return rows.length > 0 && sum('debit') === sum('credit');
  }

  // ------------------------------------------------------------ #114 defaults

  it('finds a hybrid default booked on the whole balance and gives back what was never fronted', async () => {
    const merchantId = await freshMerchant();
    const { plan, schedule } = await activate('hybrid', merchantId);
    await plans.recordManualPayment(schedule[0]!.id, {}, ACTOR);
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(35_600);
    await bookPre114Default(plan.id);
    // The damage: credited 35,600, clawed 57,200.
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(-21_600);

    const listed = (await repairs.findOversizedDefaults()).find(
      (d) => d.customerPlanId === plan.id,
    );
    expect(listed).toMatchObject({
      businessModel: 'hybrid',
      frontedOpenPesewas: 0,
      writtenOffPesewas: 60_000,
      shouldWriteOffPesewas: 0,
      correction: { receivable: 60_000, reserve: 2_800, merchant: 57_200, pool: 0 },
    });

    const corrected = await repairs.correctOversizedDefault(plan.id, ACTOR);
    expect(corrected?.correction.merchant).toBe(57_200);
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(35_600);
    expect(await ledger.balanceOf('reserve_held', plan.id)).toBe(2_800);
    expect(await transactionBalances(`compensate:default:${plan.id}`)).toBe(true);
    expect((await repairs.findOversizedDefaults()).some((d) => d.customerPlanId === plan.id)).toBe(
      false,
    );

    // The restored reserve is the merchant's, on the default's release clock.
    const [row] = await db
      .select()
      .from(schema.held_reserves)
      .where(eq(schema.held_reserves.customer_plan_id, plan.id));
    expect(row!.consumed_for_default_pesewas).toBe(0);
    expect(row!.fully_released_at).toBeNull();
    expect(row!.plan_defaulted_at).not.toBeNull();
    await reserves.releaseMaturedReserves(merchantId, new Date(Date.now() + 60 * 86_400_000));
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(35_600 + 2_800);
  });

  it('corrects a default once, however often it is asked', async () => {
    const merchantId = await freshMerchant();
    const { plan } = await activate('hybrid', merchantId);
    await bookPre114Default(plan.id);
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(-100_000);

    expect(await repairs.correctOversizedDefault(plan.id, ACTOR)).not.toBeNull();
    expect(await repairs.correctOversizedDefault(plan.id, ACTOR)).toBeNull();
    // Never credited anything, never clawed anything.
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(0);
  });

  it('gives a rent to own merchant back the interest a default charged them', async () => {
    const merchantId = await freshMerchant();
    const { plan } = await activate('rtoInterest', merchantId);
    expect(plan.total_payable_pesewas).toBeGreaterThan(100_000);
    const interest = plan.total_payable_pesewas - 100_000;
    await bookPre114Default(plan.id);

    const listed = (await repairs.findOversizedDefaults()).find(
      (d) => d.customerPlanId === plan.id,
    );
    // The 100,000 fronted was a real loss, shared as designed; only the
    // interest nobody fronted comes back.
    expect(listed?.correction).toEqual({
      receivable: interest,
      reserve: 0,
      merchant: interest,
      pool: 0,
    });
    await repairs.correctOversizedDefault(plan.id, ACTOR);
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(83_000 - 88_000);
  });

  it('returns a BNPL interest overcharge to the pool and leaves the merchant alone', async () => {
    const merchantId = await freshMerchant();
    const { plan, schedule } = await activate('bnplInterest', merchantId);
    await plans.recordManualPayment(schedule[0]!.id, {}, ACTOR);
    const before = await ledger.balanceOf('merchant_payable', merchantId);
    await bookPre114Default(plan.id);

    const listed = (await repairs.findOversizedDefaults()).find(
      (d) => d.customerPlanId === plan.id,
    );
    expect(listed?.correction.merchant).toBe(0);
    expect(listed?.correction.reserve).toBe(0);
    expect(listed!.correction.pool).toBeGreaterThan(0);
    expect(listed!.correction.pool).toBe(listed!.correction.receivable);

    await repairs.correctOversizedDefault(plan.id, ACTOR);
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(before);
    expect(await transactionBalances(`compensate:default:${plan.id}`)).toBe(true);
  });

  it('leaves alone a default the fixed code sized', async () => {
    const merchantId = await freshMerchant();
    const { plan, schedule } = await activate('bnpl', merchantId);
    await plans.recordManualPayment(schedule[0]!.id, {}, ACTOR);
    await plans.markPlanDefaulted(plan.id, {}, ACTOR);

    expect((await repairs.findOversizedDefaults()).some((d) => d.customerPlanId === plan.id)).toBe(
      false,
    );
    expect(await repairs.correctOversizedDefault(plan.id, ACTOR)).toBeNull();
  });

  // ------------------------------------------------------------ #111 reversals

  async function settledPayout(amount: number, day: string) {
    const merchantId = await freshMerchant();
    await db
      .update(schema.merchants)
      .set({ status: 'active', paystack_recipient_code: `RCP_${randomUUID()}` })
      .where(eq(schema.merchants.id, merchantId));
    await ledger.record([
      {
        transactionId: `seed:${merchantId}`,
        accountType: 'receivable',
        accountRef: merchantId,
        direction: 'debit',
        amountPesewas: amount,
        description: 'seed receivable',
      },
      {
        transactionId: `seed:${merchantId}`,
        accountType: 'merchant_payable',
        accountRef: merchantId,
        direction: 'credit',
        amountPesewas: amount,
        description: 'seed payable',
      },
    ]);
    const result = await settlement.settleMerchant(merchantId, new Date(day));
    expect(result.status).toBe('settled');
    return { merchantId, reference: result.reference! };
  }

  /** A `transfer.reversed` the old webhook stored, marked processed, and ignored. */
  async function storedReversal(reference: string) {
    await db.insert(schema.webhook_events).values({
      provider: 'paystack',
      provider_event_id: `evt_${randomUUID()}`,
      event_type: 'transfer.reversed',
      payload: {
        event: 'transfer.reversed',
        data: { reference, status: 'reversed', gateway_response: 'Account rejected' },
      },
      signature: 'sig',
      processed_at: new Date().toISOString(),
    });
  }

  async function payoutStatus(reference: string) {
    return (
      await db.select().from(schema.payouts).where(eq(schema.payouts.reference, reference))
    )[0]!.status;
  }

  it('applies a transfer.reversed that was ignored on a settled payout', async () => {
    const { merchantId, reference } = await settledPayout(40_000, '2026-09-11');
    await storedReversal(reference);
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(0);

    const listed = (await repairs.findIgnoredPayoutReversals()).find(
      (r) => r.reference === reference,
    );
    expect(listed).toMatchObject({ amountPesewas: 40_000, gatewayResponse: 'Account rejected' });

    expect(await repairs.applyIgnoredPayoutReversal(reference, ACTOR)).not.toBeNull();
    expect(await payoutStatus(reference)).toBe('reversed');
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(40_000);
    expect(
      (await repairs.findIgnoredPayoutReversals()).some((r) => r.reference === reference),
    ).toBe(false);
    // Once: the merchant is owed it once.
    expect(await repairs.applyIgnoredPayoutReversal(reference, ACTOR)).toBeNull();
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(40_000);
  });

  // ------------------------------------------------------------ #110 cases

  async function caseInCollections() {
    const merchantId = await freshMerchant();
    const { plan, schedule } = await activate('bnpl', merchantId);
    const row = schedule[0]!;
    await db
      .update(schema.installment_schedule)
      .set({ status: 'failed', due_date: '2000-01-01', grace_until_date: '2000-01-02' })
      .where(eq(schema.installment_schedule.id, row.id));
    const collections = new CollectionsService(db, audit);
    await collections.escalateGraceExpired(new Date(), ACTOR, { limit: 5_000 });
    await collections.openCasesForOverdue(ACTOR, new Date());
    const [c] = await db
      .select()
      .from(schema.collections_cases)
      .where(eq(schema.collections_cases.schedule_id, row.id));
    return { planId: plan.id, scheduleId: row.id, caseId: c!.id, collections };
  }

  /** A close the API took before #110: it set `closed_at` and settled nothing. */
  async function closedWithoutSettling(caseId: string, resolution: 'restructured' | 'paid') {
    await db
      .update(schema.collections_cases)
      .set({ resolution, closed_at: new Date().toISOString() })
      .where(eq(schema.collections_cases.id, caseId));
  }

  it('lists cases closed over an unpaid instalment, and reopens one', async () => {
    const restructured = await caseInCollections();
    await closedWithoutSettling(restructured.caseId, 'restructured');
    const paidInName = await caseInCollections();
    await closedWithoutSettling(paidInName.caseId, 'paid');

    const listed = await repairs.findStrandedCollectionsCases();
    expect(listed.find((c) => c.caseId === restructured.caseId)?.resolution).toBe('restructured');
    expect(listed.find((c) => c.caseId === paidInName.caseId)?.resolution).toBe('paid');

    await expect(repairs.reopenStrandedCase(restructured.caseId, '  ', ACTOR)).rejects.toThrow(
      MoneyRepairError,
    );
    await repairs.reopenStrandedCase(restructured.caseId, 'No restructuring was issued', ACTOR);
    const [c] = await db
      .select()
      .from(schema.collections_cases)
      .where(eq(schema.collections_cases.id, restructured.caseId));
    expect(c!.closed_at).toBeNull();
    expect(c!.resolution).toBeNull();
    expect(
      (await repairs.findStrandedCollectionsCases()).some((x) => x.caseId === restructured.caseId),
    ).toBe(false);
    // Open again, the case can be closed properly — as waived, here.
    await restructured.collections.closeCase(
      restructured.caseId,
      { resolution: 'waived', notes: 'Forgiven' },
      ACTOR,
    );
    const [s] = await db
      .select()
      .from(schema.installment_schedule)
      .where(eq(schema.installment_schedule.id, restructured.scheduleId));
    expect(s!.status).toBe('waived');

    await expect(repairs.reopenStrandedCase(restructured.caseId, 'again', ACTOR)).rejects.toThrow(
      MoneyRepairError,
    );
  });

  it('does not list a case closed the way that settles the instalment', async () => {
    const waived = await caseInCollections();
    await waived.collections.closeCase(waived.caseId, { resolution: 'waived' }, ACTOR);
    const paid = await caseInCollections();
    await plans.recordManualPayment(paid.scheduleId, {}, ACTOR);
    await paid.collections.runSweep(ACTOR, new Date());

    const listed = await repairs.findStrandedCollectionsCases();
    expect(listed.some((c) => c.caseId === waived.caseId)).toBe(false);
    expect(listed.some((c) => c.caseId === paid.caseId)).toBe(false);
  });

  // ------------------------------------------------------------ review findings

  it("shows the corrected default on the plan's settlement view", async () => {
    const merchantId = await freshMerchant();
    const { plan, schedule } = await activate('hybrid', merchantId);
    await plans.recordManualPayment(schedule[0]!.id, {}, ACTOR);
    await bookPre114Default(plan.id);
    await repairs.correctOversizedDefault(plan.id, ACTOR);

    // The admin plan view and the merchant portal read this. Uncorrected it
    // said 60,000 written off and 57,200 clawed — while ops told the merchant
    // it had been returned.
    const view = await new MerchantDashboardService(db, ledger).getPlanSettlement(plan.id);
    expect(view).toMatchObject({
      defaultWrittenOffPesewas: 0,
      defaultClawedFromMerchantPesewas: 0,
      defaultConsumedFromReservePesewas: 0,
    });
  });

  it('leaves receivable and float settled when the deposit was paid after the default', async () => {
    const merchantId = await freshMerchant();
    const { plan, schedule } = await activate('hybrid', merchantId);
    await bookPre114Default(plan.id);
    // The deposit arrives after the write-off. The oversized credit left
    // nothing "owed", so the cash went to float and the accrual's sweep found
    // nothing to retire.
    await plans.recordManualPayment(schedule[0]!.id, {}, ACTOR);

    await repairs.correctOversizedDefault(plan.id, ACTOR);

    // Where the fixed sizing would have left it: nothing owed, nothing held.
    expect(await ledger.balanceOf('receivable', plan.id)).toBe(0);
    expect(await ledger.balanceOf('customer_float', plan.id)).toBe(0);
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(35_600);
  });

  it('reports a reversal applied once when two operators apply it at once', async () => {
    const { merchantId, reference } = await settledPayout(30_000, '2026-09-12');
    await storedReversal(reference);

    const results = await Promise.all([
      repairs.applyIgnoredPayoutReversal(reference, ACTOR),
      repairs.applyIgnoredPayoutReversal(reference, ACTOR),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(30_000);
    const payout = (
      await db.select().from(schema.payouts).where(eq(schema.payouts.reference, reference))
    )[0]!;
    const applied = await db
      .select()
      .from(schema.audit_events)
      .where(eq(schema.audit_events.entity_id, payout.id));
    expect(applied.filter((e) => e.event_type === 'payout.reversal_applied')).toHaveLength(1);
  });

  it('reopens an old case at the start of the ladder, not straight into write-off', async () => {
    const stranded = await caseInCollections();
    // Opened a hundred days ago and closed at firm_reminder.
    await db
      .update(schema.collections_cases)
      .set({
        opened_at: new Date(Date.now() - 100 * 86_400_000).toISOString(),
        current_stage: 'firm_reminder',
      })
      .where(eq(schema.collections_cases.id, stranded.caseId));
    await closedWithoutSettling(stranded.caseId, 'restructured');

    await repairs.reopenStrandedCase(stranded.caseId, 'Nobody decided anything', ACTOR);
    // The nightly sweep, with a defaulter wired as production wires it.
    await new CollectionsService(db, audit, plans).runSweep(ACTOR, new Date());

    const [c] = await db
      .select()
      .from(schema.collections_cases)
      .where(eq(schema.collections_cases.id, stranded.caseId));
    // Escalation reads `opened_at`. Left at a hundred days, the case went to
    // write_off on this sweep and the whole plan defaulted.
    expect(c!.closed_at).toBeNull();
    expect(c!.current_stage).toBe('soft_reminder');
    const [p] = await db
      .select()
      .from(schema.customer_plans)
      .where(eq(schema.customer_plans.id, stranded.planId));
    expect(p!.status).toBe('active');
  });

  it('does not list a case whose plan has since been written off', async () => {
    const stranded = await caseInCollections();
    await closedWithoutSettling(stranded.caseId, 'restructured');
    await plans.markPlanDefaulted(stranded.planId, {}, ACTOR);

    expect(
      (await repairs.findStrandedCollectionsCases()).some((c) => c.caseId === stranded.caseId),
    ).toBe(false);
  });

  // ------------------------------------------------------------ report

  it('reports every kind at once, and reading changes nothing', async () => {
    const count = async () =>
      Number(
        (await db.execute(sql`SELECT count(*) AS n FROM ledger_entries`)).rows[0]!.n as string,
      );
    const before = await count();
    const report = await repairs.report();
    expect(Array.isArray(report.oversizedDefaults)).toBe(true);
    expect(Array.isArray(report.ignoredPayoutReversals)).toBe(true);
    expect(Array.isArray(report.strandedCollectionsCases)).toBe(true);
    expect(Array.isArray(report.unresolvedPaymentAttempts)).toBe(true);
    expect(await count()).toBe(before);
  });
});
