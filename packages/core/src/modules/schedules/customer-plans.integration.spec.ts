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
