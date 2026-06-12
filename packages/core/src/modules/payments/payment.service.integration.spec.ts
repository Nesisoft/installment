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
import type { RetryJob, RetryScheduler } from './retry-scheduler';

const RUN_DB = Boolean(process.env.DATABASE_URL);
const ALWAYS_OPEN = { set: async () => 'OK' as const, eval: async () => 1 };

/** Records the retry jobs it was asked to enqueue. */
function fakeRetryScheduler(): RetryScheduler & { jobs: RetryJob[] } {
  const jobs: RetryJob[] = [];
  return { jobs, scheduleRetry: async (job) => void jobs.push(job) };
}

interface PaystackFakeData {
  reference: string;
  status: string;
  gateway_response?: string;
}

/** A fake Paystack client. Each method either returns the configured outcome
 * (when stubbed) or throws if accidentally called. */
function fakePaystack(opts: {
  card?: PaystackFakeData | Error;
  momo?: PaystackFakeData | Error;
  verify?: PaystackFakeData | Error;
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
    verifyTransaction: async () => {
      if (!opts.verify) throw new Error('verifyTransaction not stubbed');
      if (opts.verify instanceof Error) throw opts.verify;
      return { data: opts.verify };
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
  const VERIFY_ACTOR = { actorId: SYSTEM_ACTORS.VERIFY_WORKER, actorType: 'worker' as const };

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

  /** A schedule driven to `processing` with an in-flight MoMo attempt under a known reference. */
  async function inflightMomoAttempt(): Promise<{
    scheduleId: string;
    planId: string;
    attemptId: string;
    reference: string;
  }> {
    const { planId, scheduleId } = await freshPlan();
    const svc = service(fakePaystack({ momo: { reference: 'ps_pending', status: 'pay_offline' } }));
    const result = await svc.chargeMobileMoney(
      { scheduleId, email: 'kofi@x.gh', phone: '+233244000111', provider: 'mtn' },
      ACTOR,
    );
    return {
      planId,
      scheduleId,
      attemptId: result.attempt.id,
      reference: result.providerReference!,
    };
  }

  function service(paystack: PaystackChargeClient): PaymentService {
    return new PaymentService(plans, scheduleState, attempts, paystack);
  }

  function serviceWithRetry(paystack: PaystackChargeClient, retry: RetryScheduler): PaymentService {
    return new PaymentService(plans, scheduleState, attempts, paystack, retry);
  }

  /** Records receipt-notifier calls so we can assert which SMS fired. */
  function fakeReceipts() {
    const succeeded: Array<{ scheduleId: string; amount: number }> = [];
    const failed: Array<{ scheduleId: string; amount: number }> = [];
    return {
      succeeded,
      failed,
      async notifyChargeSucceeded(scheduleId: string, amount: number) {
        succeeded.push({ scheduleId, amount });
      },
      async notifyChargeFailed(scheduleId: string, amount: number) {
        failed.push({ scheduleId, amount });
      },
    };
  }

  /** Lets async fire-and-forget receipt callbacks settle before assertions. */
  const flush = () => new Promise((r) => setImmediate(r));

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

  it('records a retryable card decline → schedule failed', async () => {
    const { scheduleId } = await freshPlan();
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
    expect((await plans.getInstallment(scheduleId)).status).toBe('failed');
  });

  it('escalates a non-retryable card decline → schedule overdue', async () => {
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
    expect((await plans.getInstallment(scheduleId)).status).toBe('processing');
    expect((await plans.get(planId)).outstanding_pesewas).toBe(500_000);
  });

  it('settles immediately on a synchronous MoMo success', async () => {
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
    expect((await plans.getInstallment(scheduleId)).status).toBe('failed');
  });

  // ----------------------------------------------------------- verify path

  it('verify resolves a stuck attempt as succeeded (schedule paid, outstanding reduced)', async () => {
    const { planId, scheduleId, attemptId, reference } = await inflightMomoAttempt();
    const svc = service(fakePaystack({ verify: { reference, status: 'success' } }));

    const result = await svc.verifyAttempt(attemptId, VERIFY_ACTOR);

    expect(result.status).toBe('succeeded');
    expect(result.attempt.status).toBe('succeeded');
    expect((await plans.getInstallment(scheduleId)).status).toBe('paid');
    expect((await plans.get(planId)).outstanding_pesewas).toBe(375_000);
  });

  it('verify resolves a stuck attempt as failed', async () => {
    const { scheduleId, attemptId, reference } = await inflightMomoAttempt();
    const svc = service(
      fakePaystack({ verify: { reference, status: 'failed', gateway_response: 'pin_timeout' } }),
    );

    const result = await svc.verifyAttempt(attemptId, VERIFY_ACTOR);

    expect(result.status).toBe('failed');
    expect(result.failureReason).toBe('pin_timeout');
    expect((await plans.getInstallment(scheduleId)).status).toBe('failed');
  });

  it('verify still-pending bumps the poll count and times out at MAX_VERIFY_POLLS', async () => {
    const { scheduleId, attemptId, reference } = await inflightMomoAttempt();
    const svc = service(fakePaystack({ verify: { reference, status: 'pending' } }));

    const first = await svc.verifyAttempt(attemptId, VERIFY_ACTOR);
    expect(first.status).toBe('pending');
    expect(first.attempt.verify_poll_count).toBe(1);

    const second = await svc.verifyAttempt(attemptId, VERIFY_ACTOR);
    expect(second.status).toBe('failed'); // MAX_VERIFY_POLLS=2 → timeout
    expect(second.failureReason).toBe('timeout_no_resolution');
    expect((await plans.getInstallment(scheduleId)).status).toBe('failed');
  });

  it('verify is a no-op for an already-resolved attempt (no Paystack call)', async () => {
    const { attemptId } = await inflightMomoAttempt();
    // Mark the attempt resolved without going through verify.
    await attempts.update(attemptId, { status: 'succeeded', settledAt: new Date() });

    // verifyTransaction is NOT stubbed — would throw if called.
    const svc = service(fakePaystack({}));
    const result = await svc.verifyAttempt(attemptId, VERIFY_ACTOR);
    expect(result.status).toBe('succeeded');
  });

  it('verify is idempotent when the schedule is already settled by a webhook', async () => {
    const { scheduleId, attemptId, reference } = await inflightMomoAttempt();
    // Webhook settled the schedule first (leaving the attempt row as-is).
    await plans.recordChargeSuccess(scheduleId, { providerReference: reference }, ACTOR);
    expect((await plans.getInstallment(scheduleId)).status).toBe('paid');

    const svc = service(fakePaystack({ verify: { reference, status: 'success' } }));
    const result = await svc.verifyAttempt(attemptId, VERIFY_ACTOR);

    expect(result.status).toBe('succeeded');
    expect(result.attempt.status).toBe('succeeded');
    // No double-settle — schedule is still paid, plan still 375_000.
    expect((await plans.getInstallment(scheduleId)).status).toBe('paid');
  });

  // ----------------------------------------------------------- retry scheduling

  it('schedules the next retry on a retryable decline (schedule → retry_scheduled)', async () => {
    const { scheduleId } = await freshPlan();
    const retry = fakeRetryScheduler();
    const svc = serviceWithRetry(
      fakePaystack({
        card: { reference: 'ps_no', status: 'failed', gateway_response: 'insufficient_funds' },
      }),
      retry,
    );

    const result = await svc.chargeCard(
      { scheduleId, authorizationCode: 'AUTH_x', email: 'kofi@x.gh' },
      ACTOR,
    );

    expect(result.status).toBe('failed');
    expect((await plans.getInstallment(scheduleId)).status).toBe('retry_scheduled');
    expect(retry.jobs).toHaveLength(1);
    expect(retry.jobs[0]).toMatchObject({
      scheduleId,
      attempt: 2,
      channel: 'auto_debit',
      delayMs: 4 * 3_600_000, // retry #2 fires at T+4h
    });
  });

  it('does not schedule a retry for a non-retryable decline (escalates to overdue)', async () => {
    const { scheduleId } = await freshPlan();
    const retry = fakeRetryScheduler();
    const svc = serviceWithRetry(
      fakePaystack({
        card: { reference: 'ps_blk', status: 'failed', gateway_response: 'blocked_card' },
      }),
      retry,
    );

    await svc.chargeCard({ scheduleId, authorizationCode: 'AUTH_x', email: 'kofi@x.gh' }, ACTOR);

    expect((await plans.getInstallment(scheduleId)).status).toBe('overdue');
    expect(retry.jobs).toHaveLength(0);
  });

  it('leaves the schedule failed (no retry) once attempts are exhausted', async () => {
    const { scheduleId } = await freshPlan();
    const retry = fakeRetryScheduler();
    const decline = fakePaystack({
      card: { reference: 'ps_no', status: 'failed', gateway_response: 'insufficient_funds' },
    });
    const svc = serviceWithRetry(decline, retry);

    // Attempts 1..3 each fail and schedule the next; attempt 4 fails with no further retry.
    for (let i = 0; i < 4; i++) {
      await svc.chargeCard({ scheduleId, authorizationCode: 'AUTH_x', email: 'kofi@x.gh' }, ACTOR);
    }

    expect((await plans.getInstallment(scheduleId)).status).toBe('failed');
    // 3 retries enqueued (for attempts 2, 3, 4); attempt 4's failure has none.
    expect(retry.jobs.map((j) => j.attempt)).toEqual([2, 3, 4]);
    expect(retry.jobs.at(-1)?.channel).toBe('payment_link'); // attempt 4 → link fallback
  });

  // ----------------------------------------------------------- receipts

  it('fires a success receipt SMS when a card charge settles', async () => {
    const { scheduleId } = await freshPlan();
    const receipts = fakeReceipts();
    const svc = new PaymentService(
      plans,
      scheduleState,
      attempts,
      fakePaystack({ card: { reference: 'ps_ok', status: 'success' } }),
      undefined,
      receipts,
    );

    await svc.chargeCard({ scheduleId, authorizationCode: 'AUTH_x', email: 'kofi@x.gh' }, ACTOR);
    await flush();

    expect(receipts.succeeded).toEqual([{ scheduleId, amount: 125_000 }]);
    expect(receipts.failed).toHaveLength(0);
  });

  it('fires a failure receipt on a non-retryable decline (terminal)', async () => {
    const { scheduleId } = await freshPlan();
    const receipts = fakeReceipts();
    const svc = new PaymentService(
      plans,
      scheduleState,
      attempts,
      fakePaystack({
        card: { reference: 'ps_blk', status: 'failed', gateway_response: 'blocked_card' },
      }),
      undefined,
      receipts,
    );

    await svc.chargeCard({ scheduleId, authorizationCode: 'AUTH_x', email: 'kofi@x.gh' }, ACTOR);
    await flush();

    expect(receipts.failed).toEqual([{ scheduleId, amount: 125_000 }]);
    expect(receipts.succeeded).toHaveLength(0);
  });

  it('does NOT fire a failure receipt on a retryable decline (a retry is queued)', async () => {
    const { scheduleId } = await freshPlan();
    const receipts = fakeReceipts();
    const retry = fakeRetryScheduler();
    const svc = new PaymentService(
      plans,
      scheduleState,
      attempts,
      fakePaystack({
        card: { reference: 'ps_no', status: 'failed', gateway_response: 'insufficient_funds' },
      }),
      retry,
      receipts,
    );

    await svc.chargeCard({ scheduleId, authorizationCode: 'AUTH_x', email: 'kofi@x.gh' }, ACTOR);
    await flush();

    expect(retry.jobs).toHaveLength(1); // retry queued
    expect(receipts.failed).toHaveLength(0); // …so no "we failed" SMS yet
    expect(receipts.succeeded).toHaveLength(0);
  });
});
