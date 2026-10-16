import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '@installment/db';
import { AuditLogger } from '../audit/audit-logger.service';
import { SYSTEM_ACTORS } from '../../shared/constants/system-actors';
import { MerchantsService } from '../merchants/merchants.service';
import { CustomersService } from '../customers/customers.service';
import { MockGhanaCardVerifier } from '../customers/ghana-card-verifier';
import { PlanTemplatesService } from '../plans/plan-templates.service';
import { ApplicationsService } from './applications.service';
import { PlanNotOfferedError } from './errors';
import { CustomerPlansService } from '../schedules/customer-plans.service';
import { ScheduleGenerator } from '../schedules/schedule-generator';

const RUN_DB = Boolean(process.env.DATABASE_URL);

/**
 * The terms a customer applied under are the terms they get.
 *
 * An application stored only `plan_template_id` and the amount, and
 * activation read the template's terms live. The template's interest rate,
 * service fee, late fees and grace period are all editable on a live template
 * (`updatePlanTemplateSchema`) — so an application that sat in manual review
 * while staff repriced the template was activated at the new price, not the
 * one the customer was quoted and agreed to.
 *
 * And nothing checked the plan was on offer at all: `checkEligibility` (active,
 * inside its effective window) had no caller, so an application could be
 * submitted against a template staff had withdrawn or that had expired.
 */
describe.skipIf(!RUN_DB)('plan terms are locked at application (integration)', () => {
  const { db, pool } = createTestDb();
  const audit = new AuditLogger();
  const merchants = new MerchantsService(db, audit);
  const customers = new CustomersService(db, audit, new MockGhanaCardVerifier());
  const templates = new PlanTemplatesService(db, audit);
  const apps = new ApplicationsService(db, audit);
  const plans = new CustomerPlansService(db, audit);
  const ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  const QUOTED = {
    down_payment_bps: 2500,
    interest_rate_bps: 500,
    service_fee_flat_pesewas: 1_000,
    grace_period_days: 3,
    late_fee_bps_per_week: 200,
    late_fee_cap_bps: 1500,
  };

  let merchantId: string;

  beforeAll(async () => {
    const s = randomUUID();
    merchantId = (
      await merchants.create(
        {
          business_name: `Terms ${s}`,
          legal_name: `Terms ${s}`,
          email: `terms+${s}@x.gh`,
          phone: '+233244000000',
        },
        ACTOR,
      )
    ).id;
  });

  afterAll(async () => {
    await pool.end();
  });

  async function template(overrides: Record<string, unknown> = {}) {
    return templates.create(
      {
        name: `Terms ${randomUUID()}`,
        business_model: 'bnpl',
        number_of_installments: 4,
        installment_frequency_days: 7,
        min_amount_pesewas: 1_000,
        max_amount_pesewas: 10_000_000,
        ...QUOTED,
        ...overrides,
      },
      ACTOR,
    );
  }

  async function submit(templateId: string) {
    const s = randomUUID();
    const customer = await customers.register(
      {
        first_name: 'Locked',
        last_name: 'Terms',
        email: `lt+${s}@x.gh`,
        phone: `024${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
      },
      ACTOR,
    );
    return apps.submit(
      {
        customer_id: customer.id,
        merchant_id: merchantId,
        plan_template_id: templateId,
        order_reference: `ORD-${s}`,
        order_amount_pesewas: 100_000,
        merchant_category: 'electronics',
      },
      ACTOR,
    );
  }

  it('records the terms on the application when it is submitted', async () => {
    const t = await template();
    const app = await submit(t.id);
    expect(app.plan_terms).toEqual({
      business_model: 'bnpl',
      number_of_installments: 4,
      installment_frequency_days: 7,
      ...QUOTED,
    });
  });

  it('activates on the terms applied under, not a later edit to the template', async () => {
    const t = await template();
    const app = await submit(t.id);

    // Staff reprice the template while the application waits for a decision.
    await templates.update(
      t.id,
      {
        interest_rate_bps: 2_000,
        service_fee_flat_pesewas: 5_000,
        grace_period_days: 10,
        late_fee_bps_per_week: 500,
        late_fee_cap_bps: 3_000,
      },
      ACTOR,
    );

    await apps.recordDecision(app.id, { outcome: 'approved' }, ACTOR);
    const { plan } = await plans.activateFromApplication(app.id, ACTOR);

    const quoted = new ScheduleGenerator().generate({
      businessModel: 'bnpl',
      orderAmountPesewas: 100_000,
      downPaymentBps: QUOTED.down_payment_bps,
      interestRateBps: QUOTED.interest_rate_bps,
      serviceFeeFlatPesewas: QUOTED.service_fee_flat_pesewas,
      numberOfInstallments: 4,
      installmentFrequencyDays: 7,
      gracePeriodDays: QUOTED.grace_period_days,
      startDate: new Date(),
    });
    expect(plan.total_interest_pesewas).toBe(quoted.totalInterestPesewas);
    expect(plan.total_fees_pesewas).toBe(quoted.totalFeesPesewas);
    expect(plan.total_payable_pesewas).toBe(quoted.totalPayablePesewas);
    expect(plan.grace_period_days).toBe(QUOTED.grace_period_days);
    expect(plan.late_fee_bps_per_week).toBe(QUOTED.late_fee_bps_per_week);
    expect(plan.late_fee_cap_bps).toBe(QUOTED.late_fee_cap_bps);
  });

  it('refuses an application for a plan that has been withdrawn', async () => {
    const t = await template();
    await templates.deactivate(t.id, ACTOR);
    await expect(submit(t.id)).rejects.toBeInstanceOf(PlanNotOfferedError);
  });

  it('refuses an application for a plan whose offer window has closed', async () => {
    const t = await template({
      effective_from: '2020-01-01T00:00:00Z',
      effective_to: '2020-02-01T00:00:00Z',
    });
    await expect(submit(t.id)).rejects.toBeInstanceOf(PlanNotOfferedError);
  });

  it('refuses an application for a plan not yet on offer', async () => {
    const t = await template({ effective_from: '2099-01-01T00:00:00Z' });
    await expect(submit(t.id)).rejects.toBeInstanceOf(PlanNotOfferedError);
  });

  it('still activates an approved application after the plan is withdrawn', async () => {
    // Withdrawing a plan stops new applications. It must not strand one the
    // customer already applied for: its terms are locked, and nothing would
    // ever release an order whose application is approved but cannot activate.
    const t = await template();
    const app = await submit(t.id);
    await apps.recordDecision(app.id, { outcome: 'approved' }, ACTOR);
    await templates.deactivate(t.id, ACTOR);

    const { plan } = await plans.activateFromApplication(app.id, ACTOR);
    expect(plan.application_id).toBe(app.id);
  });
});
