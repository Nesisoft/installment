import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { createDb, schema } from '@installment/db';
import { AuditLogger } from '../audit/audit-logger.service';
import { SYSTEM_ACTORS } from '../../shared/constants/system-actors';
import { MerchantsService } from '../merchants/merchants.service';
import { CustomersService } from '../customers/customers.service';
import { MockGhanaCardVerifier } from '../customers/ghana-card-verifier';
import { PlanTemplatesService } from '../plans/plan-templates.service';
import { ApplicationsService } from '../applications/applications.service';
import { LedgerService } from '../../shared/ledger/ledger.service';
import { PayoutRecorder } from '../settlements/payout-recorder';
import { CustomerPlansService } from './customer-plans.service';
import {
  InstallmentNotPayableError,
  PlanActivationError,
  PlanAlreadyActiveError,
  ReceiptNotAvailableError,
} from './errors';

const RUN_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!RUN_DB)('CustomerPlansService (integration)', () => {
  const { db, pool } = createDb({ connectionString: process.env.DATABASE_URL! });
  const audit = new AuditLogger();
  const merchants = new MerchantsService(db, audit);
  const customers = new CustomersService(db, audit, new MockGhanaCardVerifier());
  const planTemplates = new PlanTemplatesService(db, audit);
  const apps = new ApplicationsService(db, audit);
  const plans = new CustomerPlansService(db, audit);
  const ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  let merchantId: string;
  let customerId: string;
  let bnplTemplateId: string;
  let hybridTemplateId: string;

  beforeAll(async () => {
    const suffix = randomUUID();
    merchantId = (
      await merchants.create(
        {
          business_name: `M ${suffix}`,
          legal_name: `M Ltd ${suffix}`,
          email: `m+${suffix}@x.gh`,
          phone: '+233244000000',
        },
        ACTOR,
      )
    ).id;
    customerId = (
      await customers.register(
        {
          first_name: 'Ama',
          last_name: 'Mensah',
          email: `ama+${suffix}@x.gh`,
          phone: `024${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
        },
        ACTOR,
      )
    ).id;
    bnplTemplateId = (
      await planTemplates.create(
        {
          name: `BNPL ${suffix}`,
          business_model: 'bnpl',
          number_of_installments: 4,
          installment_frequency_days: 7,
          min_amount_pesewas: 1_000,
          max_amount_pesewas: 10_000_000,
        },
        ACTOR,
      )
    ).id;
    hybridTemplateId = (
      await planTemplates.create(
        {
          name: `Hybrid ${suffix}`,
          business_model: 'hybrid',
          number_of_installments: 3,
          installment_frequency_days: 30,
          down_payment_bps: 3_000,
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

  async function submit(templateId: string): Promise<string> {
    const app = await apps.submit(
      {
        customer_id: customerId,
        merchant_id: merchantId,
        plan_template_id: templateId,
        order_reference: `ORD-${randomUUID()}`,
        order_amount_pesewas: 100_000,
        merchant_category: 'electronics',
      },
      ACTOR,
    );
    return app.id;
  }

  async function approved(templateId: string): Promise<string> {
    const id = await submit(templateId);
    await apps.recordDecision(id, { outcome: 'approved' }, ACTOR);
    return id;
  }

  async function lastPlanEvent(planId: string): Promise<string | undefined> {
    const rows = await db
      .select({ event_type: schema.audit_events.event_type })
      .from(schema.audit_events)
      .where(
        and(
          eq(schema.audit_events.entity_id, planId),
          eq(schema.audit_events.entity_type, 'customer_plan'),
        ),
      )
      .orderBy(desc(schema.audit_events.occurred_at))
      .limit(1);
    return rows[0]?.event_type;
  }

  it('activates an approved BNPL application into an active plan + 4 installments', async () => {
    const appId = await approved(bnplTemplateId);
    const { plan, schedule } = await plans.activateFromApplication(appId, ACTOR);

    expect(plan.status).toBe('active');
    expect(plan.total_payable_pesewas).toBe(100_000);
    expect(plan.outstanding_pesewas).toBe(100_000);
    expect(plan.down_payment_pesewas).toBe(0);

    expect(schedule).toHaveLength(4);
    expect(schedule.map((r) => r.sequence_number)).toEqual([1, 2, 3, 4]);
    expect(schedule.map((r) => r.amount_due_pesewas)).toEqual([25_000, 25_000, 25_000, 25_000]);
    expect(schedule.every((r) => r.status === 'pending')).toBe(true);

    expect(await lastPlanEvent(plan.id)).toBe('customer_plan.activated');
  });

  it('builds a statement from the live plan + schedule + customer/merchant', async () => {
    const appId = await approved(bnplTemplateId);
    const { plan } = await plans.activateFromApplication(appId, ACTOR);

    const statement = await plans.getStatement(plan.id);
    expect(statement.planId).toBe(plan.id);
    expect(statement.customerName).toBe('Ama Mensah');
    expect(statement.merchantName).not.toBeNull();
    expect(statement.summary.totalPayable).toBe('GHS 1,000.00');
    expect(statement.lines).toHaveLength(4);
  });

  it('activates a hybrid plan into a down-payment row plus 3 installments', async () => {
    const appId = await approved(hybridTemplateId);
    const { plan, schedule } = await plans.activateFromApplication(appId, ACTOR);

    expect(plan.down_payment_pesewas).toBe(30_000);
    expect(plan.financed_amount_pesewas).toBe(70_000);
    expect(schedule).toHaveLength(4);
    expect(schedule[0]!.amount_due_pesewas).toBe(30_000); // down payment, sequence 1
    expect(schedule.slice(1).map((r) => r.amount_due_pesewas)).toEqual([23_334, 23_333, 23_333]);
  });

  it('is idempotent — refuses to activate the same application twice', async () => {
    const appId = await approved(bnplTemplateId);
    await plans.activateFromApplication(appId, ACTOR);
    await expect(plans.activateFromApplication(appId, ACTOR)).rejects.toBeInstanceOf(
      PlanAlreadyActiveError,
    );
  });

  it('refuses to activate an application that is not approved', async () => {
    const appId = await submit(bnplTemplateId); // left pending
    await expect(plans.activateFromApplication(appId, ACTOR)).rejects.toBeInstanceOf(
      PlanActivationError,
    );
  });

  it('records a manual payment, marks the installment paid, and decrements outstanding', async () => {
    const appId = await approved(bnplTemplateId);
    const { schedule } = await plans.activateFromApplication(appId, ACTOR);

    const { schedule: paid, plan } = await plans.recordManualPayment(
      schedule[0]!.id,
      { provider_reference: 'cash-001', reason: 'paid at branch' },
      ACTOR,
    );

    expect(paid.status).toBe('paid');
    expect(paid.amount_paid_pesewas).toBe(25_000);
    expect(paid.paid_at).not.toBeNull();
    expect(paid.provider_reference).toBe('cash-001');
    expect(plan.outstanding_pesewas).toBe(75_000);
    expect(plan.status).toBe('active');
  });

  it('completes the plan when the final installment is paid', async () => {
    const appId = await approved(bnplTemplateId);
    const { plan, schedule } = await plans.activateFromApplication(appId, ACTOR);

    let last;
    for (const installment of schedule) {
      last = await plans.recordManualPayment(installment.id, {}, ACTOR);
    }

    expect(last!.plan.outstanding_pesewas).toBe(0);
    expect(last!.plan.status).toBe('completed');
    expect(last!.plan.completed_at).not.toBeNull();
    expect((await plans.get(plan.id)).status).toBe('completed');
  });

  it('refuses to pay an already-paid installment', async () => {
    const appId = await approved(bnplTemplateId);
    const { schedule } = await plans.activateFromApplication(appId, ACTOR);
    await plans.recordManualPayment(schedule[0]!.id, {}, ACTOR);
    await expect(plans.recordManualPayment(schedule[0]!.id, {}, ACTOR)).rejects.toBeInstanceOf(
      InstallmentNotPayableError,
    );
  });

  it('issues a receipt for a paid installment and refuses one for an unpaid installment', async () => {
    const appId = await approved(bnplTemplateId);
    const { schedule } = await plans.activateFromApplication(appId, ACTOR);

    await expect(plans.getReceipt(schedule[1]!.id)).rejects.toBeInstanceOf(
      ReceiptNotAvailableError,
    );

    await plans.recordManualPayment(schedule[0]!.id, { provider_reference: 'cash-007' }, ACTOR);
    const receipt = await plans.getReceipt(schedule[0]!.id);
    expect(receipt.receiptNumber).toBe('cash-007');
    expect(receipt.amountPaid).toBe('GHS 250.00');
    expect(receipt.installmentSequence).toBe(1);
    expect(receipt.customerName).toBe('Ama Mensah');
  });
});

describe.skipIf(!RUN_DB)('CustomerPlansService (integration) — payout accruals', () => {
  const { db, pool } = createDb({ connectionString: process.env.DATABASE_URL! });
  const audit = new AuditLogger();
  const ledger = new LedgerService(db);
  const payouts = new PayoutRecorder(db, ledger);
  const merchants = new MerchantsService(db, audit);
  const customers = new CustomersService(db, audit, new MockGhanaCardVerifier());
  const planTemplates = new PlanTemplatesService(db, audit);
  const apps = new ApplicationsService(db, audit);
  const plans = new CustomerPlansService(db, audit, undefined, payouts);
  const ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  let bnplTemplateId: string;
  let hybridTemplateId: string;
  let layawayTemplateId: string;
  let rtoTemplateId: string;

  beforeAll(async () => {
    const suffix = randomUUID();
    bnplTemplateId = (
      await planTemplates.create(
        {
          name: `BNPL-pay ${suffix}`,
          business_model: 'bnpl',
          number_of_installments: 4,
          installment_frequency_days: 7,
          min_amount_pesewas: 1_000,
          max_amount_pesewas: 10_000_000,
        },
        ACTOR,
      )
    ).id;
    hybridTemplateId = (
      await planTemplates.create(
        {
          name: `Hybrid-pay ${suffix}`,
          business_model: 'hybrid',
          number_of_installments: 3,
          installment_frequency_days: 30,
          down_payment_bps: 4_000,
          min_amount_pesewas: 1_000,
          max_amount_pesewas: 10_000_000,
        },
        ACTOR,
      )
    ).id;
    layawayTemplateId = (
      await planTemplates.create(
        {
          name: `Layaway-pay ${suffix}`,
          business_model: 'layaway',
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
          name: `RTO-pay ${suffix}`,
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

  async function freshMerchant(): Promise<string> {
    const suffix = randomUUID();
    return (
      await merchants.create(
        {
          business_name: `M ${suffix}`,
          legal_name: `M Ltd ${suffix}`,
          email: `m+${suffix}@x.gh`,
          phone: '+233244000000',
        },
        ACTOR,
      )
    ).id;
  }

  async function freshCustomer(): Promise<string> {
    const suffix = randomUUID();
    return (
      await customers.register(
        {
          first_name: 'Pay',
          last_name: 'Test',
          email: `pay+${suffix}@x.gh`,
          phone: `024${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
        },
        ACTOR,
      )
    ).id;
  }

  async function approved(
    templateId: string,
    merchantId: string,
    customerId: string,
    orderAmountPesewas = 100_000,
  ): Promise<string> {
    const app = await apps.submit(
      {
        customer_id: customerId,
        merchant_id: merchantId,
        plan_template_id: templateId,
        order_reference: `ORD-${randomUUID()}`,
        order_amount_pesewas: orderAmountPesewas,
        merchant_category: 'electronics',
      },
      ACTOR,
    );
    await apps.recordDecision(app.id, { outcome: 'approved' }, ACTOR);
    return app.id;
  }

  it('books an order_approved accrual on BNPL activation (100% gross, 91% net)', async () => {
    const merchantId = await freshMerchant();
    const customerId = await freshCustomer();
    const appId = await approved(bnplTemplateId, merchantId, customerId);
    const { plan } = await plans.activateFromApplication(appId, ACTOR);

    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(91_000);
    expect(await ledger.balanceOf('reserve_held', plan.id)).toBe(5_000);
    expect(await ledger.balanceOf('receivable', plan.id)).toBe(-100_000);

    // Revenue is a global account; assert the per-transaction rows landed
    // (4: debit receivable, credit merchant_payable, credit revenue, credit reserve).
    const rows = await db
      .select()
      .from(schema.ledger_entries)
      .where(eq(schema.ledger_entries.transaction_id, `accrue:${plan.id}:order_approved`));
    expect(rows).toHaveLength(4);
  });

  it('books an order_approved accrual on rent_to_own activation (88% net, 12% reserve)', async () => {
    const merchantId = await freshMerchant();
    const customerId = await freshCustomer();
    const appId = await approved(rtoTemplateId, merchantId, customerId);
    const { plan } = await plans.activateFromApplication(appId, ACTOR);

    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(83_000); // 100k - 5k MDR - 12k reserve
    expect(await ledger.balanceOf('reserve_held', plan.id)).toBe(12_000);
  });

  it('books nothing on hybrid activation — accrual waits for the down payment', async () => {
    const merchantId = await freshMerchant();
    const customerId = await freshCustomer();
    const appId = await approved(hybridTemplateId, merchantId, customerId);
    const { plan } = await plans.activateFromApplication(appId, ACTOR);

    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(0);
    expect(await ledger.balanceOf('receivable', plan.id)).toBe(0);
  });

  it('books down_payment_received when the hybrid first installment is paid (40% gross)', async () => {
    const merchantId = await freshMerchant();
    const customerId = await freshCustomer();
    const appId = await approved(hybridTemplateId, merchantId, customerId);
    const { plan, schedule } = await plans.activateFromApplication(appId, ACTOR);

    await plans.recordManualPayment(schedule[0]!.id, { provider_reference: 'down-001' }, ACTOR);

    // 40% of 100k → gross 40k, MDR 4% = 1_600, reserve 7% = 2_800, net = 35_600
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(35_600);
    expect(await ledger.balanceOf('reserve_held', plan.id)).toBe(2_800);
    expect(await ledger.balanceOf('receivable', plan.id)).toBe(-40_000);
  });

  it('books both hybrid slices once the plan completes (40% + 60% = 100% gross)', async () => {
    const merchantId = await freshMerchant();
    const customerId = await freshCustomer();
    const appId = await approved(hybridTemplateId, merchantId, customerId);
    const { plan, schedule } = await plans.activateFromApplication(appId, ACTOR);

    for (const row of schedule) {
      await plans.recordManualPayment(row.id, {}, ACTOR);
    }

    // gross totals: 100k; MDR 4% of 100k = 4k; reserve 7% of 100k = 7k; net = 89k
    expect((await plans.get(plan.id)).status).toBe('completed');
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(89_000);
    expect(await ledger.balanceOf('reserve_held', plan.id)).toBe(7_000);
    expect(await ledger.balanceOf('receivable', plan.id)).toBe(-100_000);
  });

  it('books plan_completed (100%) for layaway only when the plan completes', async () => {
    const merchantId = await freshMerchant();
    const customerId = await freshCustomer();
    const appId = await approved(layawayTemplateId, merchantId, customerId);
    const { plan, schedule } = await plans.activateFromApplication(appId, ACTOR);

    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(0); // none on activation

    for (const row of schedule.slice(0, -1)) {
      await plans.recordManualPayment(row.id, {}, ACTOR);
    }
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(0); // none mid-plan

    await plans.recordManualPayment(schedule.at(-1)!.id, {}, ACTOR);
    // 100k order, 3% MDR, 2% reserve → net 95k, reserve 2k
    expect((await plans.get(plan.id)).status).toBe('completed');
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(95_000);
    expect(await ledger.balanceOf('reserve_held', plan.id)).toBe(2_000);
  });

  it('is idempotent — replaying activation throws (cannot double-book order_approved)', async () => {
    const merchantId = await freshMerchant();
    const customerId = await freshCustomer();
    const appId = await approved(bnplTemplateId, merchantId, customerId);

    await plans.activateFromApplication(appId, ACTOR);
    await expect(plans.activateFromApplication(appId, ACTOR)).rejects.toBeInstanceOf(
      PlanAlreadyActiveError,
    );
    // First activation booked once; balance unchanged by the rejected replay.
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(91_000);
  });
});
