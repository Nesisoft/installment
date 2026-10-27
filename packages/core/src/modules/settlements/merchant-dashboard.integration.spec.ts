import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, schema } from '@installment/db';
import { AuditLogger } from '../audit/audit-logger.service';
import { SYSTEM_ACTORS } from '../../shared/constants/system-actors';
import { MerchantsService } from '../merchants/merchants.service';
import { CustomersService } from '../customers/customers.service';
import { MockGhanaCardVerifier } from '../customers/ghana-card-verifier';
import { PlanTemplatesService } from '../plans/plan-templates.service';
import { ApplicationsService } from '../applications/applications.service';
import { CustomerPlansService } from '../schedules/customer-plans.service';
import { LedgerService } from '../../shared/ledger/ledger.service';
import { PayoutRecorder } from './payout-recorder';
import { ReserveReleaseService } from './reserve-release.service';
import { DefaultService } from './default.service';
import { SettlementService, type PayoutTransferClient } from './settlement.service';
import { MerchantDashboardService } from './merchant-dashboard.service';

const RUN_DB = Boolean(process.env.DATABASE_URL);

function transfers(status = 'success'): PayoutTransferClient {
  return {
    async initiateTransfer(req) {
      return { data: { transfer_code: `TRF_${req.reference}`, reference: req.reference, status } };
    },
  };
}

describe.skipIf(!RUN_DB)('MerchantDashboardService (integration)', () => {
  const { db, pool } = createTestDb();
  const audit = new AuditLogger();
  const ledger = new LedgerService(db);
  const payouts = new PayoutRecorder(db, ledger);
  const reserves = new ReserveReleaseService(db, ledger);
  const defaults = new DefaultService(db, ledger, reserves);
  const dashboard = new MerchantDashboardService(db, ledger);
  const merchants = new MerchantsService(db, audit);
  const customers = new CustomersService(db, audit, new MockGhanaCardVerifier());
  const planTemplates = new PlanTemplatesService(db, audit);
  const apps = new ApplicationsService(db, audit);
  const plans = new CustomerPlansService(db, audit, undefined, payouts, reserves, defaults);
  const ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  let bnplTemplateId: string;
  let rtoTemplateId: string;

  beforeAll(async () => {
    const suffix = randomUUID();
    bnplTemplateId = (
      await planTemplates.create(
        {
          name: `BNPL-dash ${suffix}`,
          business_model: 'bnpl',
          number_of_installments: 4,
          installment_frequency_days: 7,
          min_amount_pesewas: 1_000,
          max_amount_pesewas: 10_000_000,
        },
        ACTOR,
      )
    ).id;
    rtoTemplateId = (
      await planTemplates.create(
        {
          name: `RTO-dash ${suffix}`,
          business_model: 'rent_to_own',
          number_of_installments: 12,
          installment_frequency_days: 30,
          min_amount_pesewas: 1_000,
          max_amount_pesewas: 10_000_000,
        },
        ACTOR,
      )
    ).id;
  });

  afterAll(async () => {
    await pool.end();
  });

  async function freshMerchant(activateAndRecipient = true): Promise<string> {
    const suffix = randomUUID();
    const merchant = await merchants.create(
      {
        business_name: `M ${suffix}`,
        legal_name: `M Ltd ${suffix}`,
        email: `m+${suffix}@x.gh`,
        phone: '+233244000000',
      },
      ACTOR,
    );
    if (activateAndRecipient) {
      await db
        .update(schema.merchants)
        .set({ status: 'active', paystack_recipient_code: `RCP_${suffix}` })
        .where(eq(schema.merchants.id, merchant.id));
    }
    return merchant.id;
  }

  async function freshCustomer(): Promise<string> {
    const suffix = randomUUID();
    return (
      await customers.register(
        {
          first_name: 'Dash',
          last_name: 'Test',
          email: `d+${suffix}@x.gh`,
          phone: `024${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
        },
        ACTOR,
      )
    ).id;
  }

  async function activate(
    templateId: string,
    merchantId: string,
    customerId: string,
    order = 100_000,
  ) {
    const app = await apps.submit(
      {
        customer_id: customerId,
        merchant_id: merchantId,
        plan_template_id: templateId,
        order_reference: `ORD-${randomUUID()}`,
        order_amount_pesewas: order,
        merchant_category: 'electronics',
      },
      ACTOR,
    );
    await apps.recordDecision(app.id, { outcome: 'approved' }, ACTOR);
    return plans.activateFromApplication(app.id, ACTOR);
  }

  it('balances reflects live payable, reserve held, lifetime settled and active-plan counts', async () => {
    const merchantId = await freshMerchant();
    const customerId = await freshCustomer();
    await activate(bnplTemplateId, merchantId, customerId);

    const before = await dashboard.getBalances(merchantId);
    expect(before.payablePesewas).toBe(91_000); // BNPL 100k → 91k net
    expect(before.reserveHeldPesewas).toBe(5_000); // 5% reserve
    expect(before.lifetimeSettledPesewas).toBe(0);
    expect(before.openReservesCount).toBe(1);
    expect(before.activePlans).toBe(1);

    // Settle today and check lifetime tally moves.
    const settlement = new SettlementService(db, ledger, audit, transfers('success'));
    const result = await settlement.settleMerchant(merchantId, new Date('2026-09-01'));
    expect(result.status).toBe('settled');

    const after = await dashboard.getBalances(merchantId);
    expect(after.payablePesewas).toBe(0);
    expect(after.lifetimeSettledPesewas).toBe(91_000);
  });

  it('listPayouts returns the history newest first, with status filter + pagination', async () => {
    const merchantId = await freshMerchant();
    const customerId = await freshCustomer();
    await activate(bnplTemplateId, merchantId, customerId);
    const settlement = new SettlementService(db, ledger, audit, transfers('success'));

    // Two settled payouts on different days. (Same-day idempotency means we
    // need fresh balance between runs.)
    await settlement.settleMerchant(merchantId, new Date('2026-09-02'));
    // Inject a second balance and settle the next day.
    await ledger.record([
      {
        transactionId: `topup:${merchantId}`,
        accountType: 'receivable',
        accountRef: merchantId,
        direction: 'debit',
        amountPesewas: 20_000,
        description: 'top-up receivable',
      },
      {
        transactionId: `topup:${merchantId}`,
        accountType: 'merchant_payable',
        accountRef: merchantId,
        direction: 'credit',
        amountPesewas: 20_000,
        description: 'top-up payable',
      },
    ]);
    await settlement.settleMerchant(merchantId, new Date('2026-09-03'));

    const page = await dashboard.listPayouts(merchantId);
    expect(page.total).toBe(2);
    expect(page.rows).toHaveLength(2);
    expect(page.rows[0]!.asOfDate >= page.rows[1]!.asOfDate).toBe(true); // newest first

    const onlySettled = await dashboard.listPayouts(merchantId, { status: 'settled' });
    expect(onlySettled.rows.every((r) => r.status === 'settled')).toBe(true);

    const paged = await dashboard.listPayouts(merchantId, { limit: 1, offset: 1 });
    expect(paged.rows).toHaveLength(1);
    expect(paged.total).toBe(2);
  });

  it('listHeldReserves splits open vs closed rows, computing outstanding + releasable date', async () => {
    const merchantId = await freshMerchant();
    const customerId = await freshCustomer();
    const { plan, schedule } = await activate(bnplTemplateId, merchantId, customerId);

    let openRows = await dashboard.listHeldReserves(merchantId);
    expect(openRows).toHaveLength(1);
    expect(openRows[0]!.customerPlanId).toBe(plan.id);
    expect(openRows[0]!.outstandingPesewas).toBe(5_000);
    expect(openRows[0]!.releasableFrom).toBeNull(); // plan_completed_at not set yet

    // Complete the plan — plan_completed_at gets stamped + the +14d release date.
    for (const row of schedule) await plans.recordManualPayment(row.id, {}, ACTOR);
    openRows = await dashboard.listHeldReserves(merchantId);
    expect(openRows[0]!.releasableFrom).not.toBeNull();
    expect(openRows[0]!.planCompletedAt).not.toBeNull();

    // Fully release, then the row should move to "closed".
    await reserves.releaseMaturedReserves(merchantId, new Date(Date.now() + 30 * 86_400_000));
    const closedRows = await dashboard.listHeldReserves(merchantId, { open: false });
    expect(closedRows).toHaveLength(1);
    expect(closedRows[0]!.fullyReleasedAt).not.toBeNull();
    expect(await dashboard.listHeldReserves(merchantId, { open: true })).toHaveLength(0);
  });

  it('getPlanSettlement returns the per-plan footprint across accruals, refunds, default', async () => {
    const merchantId = await freshMerchant();
    const customerId = await freshCustomer();
    const { plan, schedule } = await activate(bnplTemplateId, merchantId, customerId);

    // Accrual: 100k gross at activation.
    let view = (await dashboard.getPlanSettlement(plan.id))!;
    expect(view.grossAccruedPesewas).toBe(100_000);
    expect(view.refundedPesewas).toBe(0);
    expect(view.reserveHeldPesewas).toBe(5_000);
    expect(view.defaultWrittenOffPesewas).toBe(0);

    // Pay then refund one installment (25k → 25% reversal).
    await plans.recordManualPayment(schedule[0]!.id, {}, ACTOR);
    await plans.refundInstallment(schedule[0]!.id, { reason: 'returned' }, ACTOR);
    view = (await dashboard.getPlanSettlement(plan.id))!;
    expect(view.refundedPesewas).toBe(25_000);
    expect(view.reserveHeldPesewas).toBe(5_000 - 1_250);
    expect(view.defaultWrittenOffPesewas).toBe(0);
  });

  it('getPlanSettlement separates default loss into reserve vs merchant claw-back', async () => {
    const merchantId = await freshMerchant();
    const customerId = await freshCustomer();
    const { plan } = await activate(rtoTemplateId, merchantId, customerId);
    // RTO 100k: 12% reserve, 5% MDR → 12k reserve, 83k merchant payable.

    await plans.markPlanDefaulted(plan.id, {}, ACTOR); // unrecovered = 100k
    const view = (await dashboard.getPlanSettlement(plan.id))!;

    expect(view.defaultWrittenOffPesewas).toBe(100_000);
    expect(view.defaultConsumedFromReservePesewas).toBe(12_000); // full reserve
    // The remaining 88k is Ejua's on rent to own, as on BNPL; the seller,
    // paid the whole order at approval, is not clawed. (Hybrid, which is, is
    // covered in default.integration.spec.ts.)
    expect(view.defaultClawedFromMerchantPesewas).toBe(0);
  });

  it('getPlanSettlement returns null for an unknown plan', async () => {
    expect(await dashboard.getPlanSettlement(randomUUID())).toBeNull();
  });

  /**
   * Books a balanced merchant_payable movement at a chosen instant. Services
   * always stamp occurred_at = NOW(), so the statement period tests insert
   * directly to place activity in specific months.
   */
  async function bookAt(
    merchantId: string,
    transactionId: string,
    direction: 'debit' | 'credit',
    amountPesewas: number,
    occurredAtIso: string,
  ) {
    await db.insert(schema.ledger_entries).values([
      {
        transaction_id: transactionId,
        account_type: 'merchant_payable',
        account_ref: merchantId,
        direction,
        amount_pesewas: amountPesewas,
        currency: 'GHS',
        description: `${transactionId} ${direction}`,
        occurred_at: occurredAtIso,
      },
      {
        transaction_id: transactionId,
        account_type: 'paystack_settlement',
        account_ref: 'main',
        direction: direction === 'credit' ? 'debit' : 'credit',
        amount_pesewas: amountPesewas,
        currency: 'GHS',
        description: `${transactionId} contra`,
        occurred_at: occurredAtIso,
      },
    ]);
  }

  it('getMonthlyStatement carries the opening balance, filters to the month, totals the period', async () => {
    const merchantId = await freshMerchant();

    // Prior months → opening balance at 1 Mar = 50_000 − 20_000 = 30_000.
    await bookAt(
      merchantId,
      `accrue:${randomUUID()}:order_approved`,
      'credit',
      50_000,
      '2026-01-15T09:00:00.000Z',
    );
    await bookAt(merchantId, `payout:${randomUUID()}`, 'debit', 20_000, '2026-02-10T09:00:00.000Z');
    // March activity.
    await bookAt(
      merchantId,
      `accrue:${randomUUID()}:order_approved`,
      'credit',
      91_000,
      '2026-03-05T09:00:00.000Z',
    );
    await bookAt(
      merchantId,
      `payout:${randomUUID()}`,
      'debit',
      100_000,
      '2026-03-20T09:00:00.000Z',
    );
    await bookAt(
      merchantId,
      `release:${randomUUID()}:2026-03-25`,
      'credit',
      5_000,
      '2026-03-25T09:00:00.000Z',
    );
    // Next month → excluded from the March statement.
    await bookAt(
      merchantId,
      `accrue:${randomUUID()}:order_approved`,
      'credit',
      12_000,
      '2026-04-02T09:00:00.000Z',
    );

    const s = await dashboard.getMonthlyStatement(merchantId, 2026, 3);

    expect(s.period).toBe('2026-03');
    expect(s.periodStart).toBe('2026-03-01');
    expect(s.periodEnd).toBe('2026-03-31');
    expect(s.merchantName).not.toBeNull();

    expect(s.summary.openingBalance).toBe('GHS 300.00'); // 30_000
    expect(s.lines).toHaveLength(3); // only March movements
    expect(s.summary.totalCredited).toBe('GHS 960.00'); // 96_000
    expect(s.summary.totalDebited).toBe('GHS 1,000.00'); // 100_000
    expect(s.summary.reserveReleased).toBe('GHS 50.00'); // 5_000
    expect(s.summary.paidOut).toBe('GHS 1,000.00'); // 100_000
    // 30_000 + 96_000 − 100_000 = 26_000
    expect(s.summary.closingBalance).toBe('GHS 260.00');

    // Lines are ascending by occurred_at and classified by transaction id.
    expect(s.lines.map((l) => l.kind)).toEqual(['accrual', 'payout', 'reserve_release']);
  });

  it('getMonthlyStatement rejects an out-of-range month', async () => {
    const merchantId = await freshMerchant();
    await expect(dashboard.getMonthlyStatement(merchantId, 2026, 13)).rejects.toBeInstanceOf(
      RangeError,
    );
  });
});
