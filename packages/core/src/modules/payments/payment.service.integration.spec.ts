import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '@installment/db';
import { AuditLogger } from '../audit/audit-logger.service';
import { EventBus } from '../../shared/event-bus/event-bus';
import { RedisLock } from '../../shared/lock/redis-lock';
import { SYSTEM_ACTORS } from '../../shared/constants/system-actors';
import { MerchantsService } from '../merchants/merchants.service';
import { CustomersService } from '../customers/customers.service';
import { MockGhanaCardVerifier } from '../customers/ghana-card-verifier';
import { PlanTemplatesService } from '../plans/plan-templates.service';
import { ApplicationsService } from '../applications/applications.service';
import { CustomerPlansService } from '../schedules/customer-plans.service';
import { ScheduleStateService } from '../schedules/schedule-state.service';
import { AttemptRepository } from './attempt-repository';
import { PaymentService, type PaystackChargeClient } from './payment.service';

const RUN_DB = Boolean(process.env.DATABASE_URL);
const ALWAYS_OPEN = { set: async () => 'OK' as const, eval: async () => 1 };

interface PaystackFakeData {
  reference: string;
  status: string;
  gateway_response?: string;
}

/** A fake Paystack client. Either chargeCard or chargeMobileMoney returns the
 * configured outcome; the other is a guard that throws if accidentally called. */
function fakePaystack(opts: {
  card?: PaystackFakeData | Error;
  momo?: PaystackFakeData | Error;
}): PaystackChargeClient {
  return {
    chargeCard: async () => {
      if (!opts.card) throw new Error('chargeCard not stubbed');
      if (opts.card instanceof Error) throw opts.card;
      return { data: opts.card };
    },
    chargeMobileMoney: async () => {
      if (!opts.momo) throw new Error('chargeMobileMoney not stubbed');
      if (opts.momo instanceof Error) throw opts.momo;
      return { data: opts.momo };
    },
  };
}

describe.skipIf(!RUN_DB)('PaymentService (integration)', () => {
  const { db, pool } = createDb({ connectionString: process.env.DATABASE_URL! });
  const audit = new AuditLogger();
  const merchants = new MerchantsService(db, audit);
  const customers = new CustomersService(db, audit, new MockGhanaCardVerifier());
  const planTemplates = new PlanTemplatesService(db, audit);
  const apps = new ApplicationsService(db, audit);
  const plans = new CustomerPlansService(db, audit);
  const scheduleState = new ScheduleStateService(
    db,
    audit,
    new RedisLock(ALWAYS_OPEN),
    new EventBus(),
  );
  const attempts = new AttemptRepository(db);
  const ACTOR = { actorId: SYSTEM_ACTORS.DEBIT_WORKER, actorType: 'worker' as const };

  let merchantId: string;
  let customerId: string;
  let templateId: string;

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
          first_name: 'Kofi',
          last_name: 'Owusu',
          email: `kofi+${suffix}@x.gh`,
          phone: `024${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
        },
        ACTOR,
      )
    ).id;
    templateId = (
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
  });

  afterAll(async () => {
    await pool.end();
  });

  async function freshPlan(): Promise<{ planId: string; scheduleId: string }> {
    const app = await apps.submit(
      {
        customer_id: customerId,
        merchant_id: merchantId,
        plan_template_id: templateId,
        order_reference: `ORD-${randomUUID()}`,
        order_amount_pesewas: 500_000,
        merchant_category: 'electronics',
      },
      ACTOR,
    );
    await apps.recordDecision(app.id, { outcome: 'approved' }, ACTOR);
    const { plan, schedule } = await plans.activateFromApplication(app.id, ACTOR);
    return { planId: plan.id, scheduleId: schedule[0]!.id };
  }

  function service(paystack: PaystackChargeClient): PaymentService {
    return new PaymentService(plans, scheduleState, attempts, paystack);
  }

  // ----------------------------------------------------------- card path

  it('charges a card successfully → schedule paid, outstanding reduced, attempt succeeded', async () => {
    const { planId, scheduleId } = await freshPlan();
    const svc = service(fakePaystack({ card: { reference: 'ps_ok', status: 'success' } }));

    const result = await svc.chargeCard(
      { scheduleId, authorizationCode: 'AUTH_x', email: 'kofi@x.gh' },
      ACTOR,
    );

    expect(result.status).toBe('succeeded');
    expect(result.attempt.status).toBe('succeeded');
    expect((await plans.getInstallment(scheduleId)).status).toBe('paid');
    expect((await plans.get(planId)).outstanding_pesewas).toBe(375_000);
  });

  it('records a retryable decline → schedule failed, outstanding unchanged', async () => {
    const { planId, scheduleId } = await freshPlan();
    const svc = service(
      fakePaystack({
        card: { reference: 'ps_no', status: 'failed', gateway_response: 'insufficient_funds' },
      }),
    );

    const result = await svc.chargeCard(
      { scheduleId, authorizationCode: 'AUTH_x', email: 'kofi@x.gh' },
      ACTOR,
    );

    expect(result.status).toBe('failed');
    expect(result.failureReason).toBe('insufficient_funds');
    expect((await plans.getInstallment(scheduleId)).status).toBe('failed');
    expect((await plans.get(planId)).outstanding_pesewas).toBe(500_000);
  });

  it('escalates a non-retryable decline → schedule overdue', async () => {
    const { scheduleId } = await freshPlan();
    const svc = service(
      fakePaystack({
        card: { reference: 'ps_blk', status: 'failed', gateway_response: 'blocked_card' },
      }),
    );
    const result = await svc.chargeCard(
      { scheduleId, authorizationCode: 'AUTH_x', email: 'kofi@x.gh' },
      ACTOR,
    );
    expect(result.status).toBe('failed');
    expect((await plans.getInstallment(scheduleId)).status).toBe('overdue');
  });

  it('leaves the attempt unknown on a network error (schedule stays processing)', async () => {
    const { scheduleId } = await freshPlan();
    const svc = service(fakePaystack({ card: new Error('socket hang up') }));
    const result = await svc.chargeCard(
      { scheduleId, authorizationCode: 'AUTH_x', email: 'kofi@x.gh' },
      ACTOR,
    );
    expect(result.status).toBe('unknown');
    expect(result.attempt.status).toBe('unknown');
    expect((await plans.getInstallment(scheduleId)).status).toBe('processing');
  });

  // ----------------------------------------------------------- MoMo path

  it('charges MoMo → pay_offline leaves the attempt in-flight (webhook resolves it)', async () => {
    const { planId, scheduleId } = await freshPlan();
    const svc = service(
      fakePaystack({ momo: { reference: 'ps_momo_pending', status: 'pay_offline' } }),
    );

    const result = await svc.chargeMobileMoney(
      { scheduleId, email: 'kofi@x.gh', phone: '+233244000111', provider: 'mtn' },
      ACTOR,
    );

    expect(result.status).toBe('pending');
    expect(result.attempt.status).toBe('in_flight');
    expect(result.providerReference).toBe('ps_momo_pending');
    // Schedule + plan are unchanged until the webhook lands.
    expect((await plans.getInstallment(scheduleId)).status).toBe('processing');
    expect((await plans.get(planId)).outstanding_pesewas).toBe(500_000);
  });

  it('settles immediately on a synchronous MoMo success (rare but supported)', async () => {
    const { planId, scheduleId } = await freshPlan();
    const svc = service(fakePaystack({ momo: { reference: 'ps_momo_ok', status: 'success' } }));

    const result = await svc.chargeMobileMoney(
      { scheduleId, email: 'kofi@x.gh', phone: '+233244000111', provider: 'mtn' },
      ACTOR,
    );

    expect(result.status).toBe('succeeded');
    expect((await plans.getInstallment(scheduleId)).status).toBe('paid');
    expect((await plans.get(planId)).outstanding_pesewas).toBe(375_000);
  });

  it('records a MoMo decline like a card decline', async () => {
    const { scheduleId } = await freshPlan();
    const svc = service(
      fakePaystack({
        momo: {
          reference: 'ps_momo_no',
          status: 'failed',
          gateway_response: 'declined_by_customer',
        },
      }),
    );

    const result = await svc.chargeMobileMoney(
      { scheduleId, email: 'kofi@x.gh', phone: '+233244000111', provider: 'mtn' },
      ACTOR,
    );

    expect(result.status).toBe('failed');
    expect(result.failureReason).toBe('declined_by_customer');
    expect((await plans.getInstallment(scheduleId)).status).toBe('failed');
  });
});
