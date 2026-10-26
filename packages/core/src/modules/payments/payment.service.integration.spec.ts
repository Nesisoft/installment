import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, schema } from '@installment/db';
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
import { CardAuthorizationService } from './card-authorization.service';
import { PaymentService, type PaystackChargeClient } from './payment.service';
import { MAX_VERIFY_POLLS } from './retry-policy';
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
  const { db, pool } = createTestDb();
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

  /**
   * What a decline actually looks like on the wire.
   *
   * Captured from Paystack test mode with the repo's own client (2026-10-19):
   * a declined `/charge` answers **HTTP 400**, `status: false`, with the
   * outcome in `data.status` and the reason as prose in `data.message`. The
   * client throws on any 400, so the charge paths parked a definite decline as
   * `unknown` with the reason "Charge attempted", and the verify poll only
   * recognised it 15-20 minutes later. The test above models a decline as a
   * 200 with a snake_case `gateway_response` — a shape Paystack never sent.
   */
  function paystack400Decline(reference: string, message: string): Error {
    return Object.assign(new Error('Charge attempted'), {
      name: 'PaystackError',
      status: 400,
      cause: {
        status: false,
        message: 'Charge attempted',
        data: { reference, status: 'failed', message },
        type: 'api_error',
        code: 'unprocessed_transaction',
      },
    });
  }
  const OBSERVED =
    'Declined. Please use the test mobile money number since you are doing a test transaction.';

  it("records a MoMo decline Paystack returns as HTTP 400 at once, with Paystack's reason", async () => {
    const { scheduleId } = await freshPlan();
    const svc = service(fakePaystack({ momo: paystack400Decline('ps_momo_400', OBSERVED) }));
    const result = await svc.chargeMobileMoney(
      { scheduleId, email: 'kofi@x.gh', phone: '+233244000111', provider: 'mtn' },
      ACTOR,
    );
    expect(result.status).toBe('failed');
    expect(result.attempt.status).toBe('failed');
    expect(result.attempt.failure_reason).toBe(OBSERVED);
    expect((await plans.getInstallment(scheduleId)).status).toBe('failed');
  });

  it('records a card decline Paystack returns as HTTP 400 the same way', async () => {
    const { scheduleId } = await freshPlan();
    const svc = service(
      fakePaystack({ card: paystack400Decline('ps_card_400', 'Insufficient Funds') }),
    );
    const result = await svc.chargeCard(
      { scheduleId, authorizationCode: 'AUTH_x', email: 'kofi@x.gh' },
      ACTOR,
    );
    expect(result.status).toBe('failed');
    expect(result.attempt.failure_reason).toBe('Insufficient Funds');
  });

  it('still parks a 400 that says nothing about the charge as unknown', async () => {
    // A rejected request (bad parameters) carries no `data.status`: nothing in
    // it says whether a charge exists, so it is left for verify to resolve.
    const { scheduleId } = await freshPlan();
    const bad = Object.assign(new Error('Invalid phone'), {
      status: 400,
      cause: { status: false, message: 'Invalid phone' },
    });
    const svc = service(fakePaystack({ momo: bad }));
    const result = await svc.chargeMobileMoney(
      { scheduleId, email: 'kofi@x.gh', phone: '+233244000111', provider: 'mtn' },
      ACTOR,
    );
    expect(result.status).toBe('unknown');
    expect((await plans.getInstallment(scheduleId)).status).toBe('processing');
  });

  // ------------------------------------------- verify: what Paystack answers
  //
  // Captured from Paystack test mode with the repo's own client (2026-10-20).
  // Verifying a reference Paystack never created answers 400
  // `transaction_not_found` — and verify treated every throw as "still
  // unknown", so a charge that never reached Paystack (a request lost in
  // transit) sat `unknown` for good and its instalment in `processing`: no
  // retry, no payment-link fallback, no collections. (A dead saved card used to
  // reach here too; it is now failed at charge time — see below.)

  const INVALID_AUTH = Object.assign(new Error('Authorization code is invalid'), {
    status: 400,
    cause: {
      status: false,
      message: 'Authorization code is invalid',
      type: 'validation_error',
      code: 'invalid_authorization_code',
    },
  });
  const NOT_FOUND_400 = Object.assign(new Error('Transaction reference not found.'), {
    status: 400,
    cause: {
      status: false,
      message: 'Transaction reference not found.',
      type: 'validation_error',
      code: 'transaction_not_found',
    },
  });

  /** A card charge whose request never reached Paystack. */
  async function unknownCardAttempt(ageMinutes: number) {
    const { scheduleId } = await freshPlan();
    const lost = new Error('socket hang up');
    const charged = await service(fakePaystack({ card: lost })).chargeCard(
      { scheduleId, authorizationCode: 'AUTH_revoked', email: 'kofi@x.gh' },
      ACTOR,
    );
    expect(charged.attempt.status).toBe('unknown');
    await db
      .update(schema.payment_attempts)
      .set({ initiated_at: new Date(Date.now() - ageMinutes * 60_000).toISOString() })
      .where(eq(schema.payment_attempts.id, charged.attempt.id));
    return { scheduleId, attemptId: charged.attempt.id };
  }

  it('closes a charge Paystack has no record of, once it is old enough to be sure', async () => {
    const { scheduleId, attemptId } = await unknownCardAttempt(20);
    const svc = service(fakePaystack({ verify: NOT_FOUND_400 }));

    const result = await svc.verifyAttempt(attemptId, VERIFY_ACTOR);

    expect(result.status).toBe('failed');
    expect(result.failureReason).toBe('not_found_at_paystack');
    // Out of `processing`, so the retry ladder and collections can see it.
    expect((await plans.getInstallment(scheduleId)).status).toBe('failed');
  });

  it('reads a 404 as not found too', async () => {
    const { attemptId } = await unknownCardAttempt(20);
    const svc = service(
      fakePaystack({ verify: Object.assign(new Error('Not found'), { status: 404 }) }),
    );
    expect((await svc.verifyAttempt(attemptId, VERIFY_ACTOR)).status).toBe('failed');
  });

  it('waits on a fresh attempt Paystack does not know yet', async () => {
    // A request that timed out on our side may still be landing at Paystack;
    // "not found" a minute later is not yet proof that no charge exists.
    const { scheduleId, attemptId } = await unknownCardAttempt(1);
    const svc = service(fakePaystack({ verify: NOT_FOUND_400 }));

    expect((await svc.verifyAttempt(attemptId, VERIFY_ACTOR)).status).toBe('unknown');
    expect((await plans.getInstallment(scheduleId)).status).toBe('processing');
  });

  it('keeps an attempt unknown when verify fails for any other reason', async () => {
    const { attemptId } = await unknownCardAttempt(20);
    const svc = service(
      fakePaystack({ verify: Object.assign(new Error('Bad gateway'), { status: 502 }) }),
    );
    expect((await svc.verifyAttempt(attemptId, VERIFY_ACTOR)).status).toBe('unknown');
  });

  it("treats an abandoned transaction as a decline, keeping Paystack's reason", async () => {
    // A declined card charge verifies as `abandoned`, not `failed`.
    const { scheduleId, attemptId, reference } = await inflightMomoAttempt();
    const svc = service(
      fakePaystack({
        verify: {
          reference,
          status: 'abandoned',
          gateway_response: 'Transaction declined. Please use the test card.',
        },
      }),
    );

    const result = await svc.verifyAttempt(attemptId, VERIFY_ACTOR);

    expect(result.status).toBe('failed');
    expect(result.failureReason).toBe('Transaction declined. Please use the test card.');
    expect((await plans.getInstallment(scheduleId)).status).toBe('failed');
  });

  // ------------------------------------- a saved card Paystack won't honour
  //
  // `CardAuthorizationService.revoke` was written for exactly this — "retires
  // an authorization the provider has told us can never work again" — and
  // nothing called it. So a dead card stayed `active`, `findUsable` picked it
  // for every debit, and the debit runner never reached its Mobile Money
  // fallback: each instalment burned an attempt on a card Paystack had already
  // refused, and then sat `unknown` for the verify poll to untangle.

  describe('a saved card Paystack no longer honours', () => {
    const cards = new CardAuthorizationService(db);
    const withCards = (paystack: PaystackChargeClient) =>
      new PaymentService(
        plans,
        scheduleState,
        attempts,
        paystack,
        undefined,
        undefined,
        undefined,
        undefined,
        cards,
      );

    async function savedCard(): Promise<string> {
      const code = `AUTH_${randomUUID().slice(0, 12)}`;
      await cards.record(customerId, {
        authorization_code: code,
        reusable: true,
        last4: '4081',
        brand: 'visa',
        exp_month: '12',
        exp_year: '2030',
      });
      return code;
    }

    async function cardRow(code: string) {
      return (
        await db
          .select()
          .from(schema.customer_card_authorizations)
          .where(eq(schema.customer_card_authorizations.authorization_code, code))
      )[0]!;
    }

    it('retires the card, and records the attempt failed at once', async () => {
      const code = await savedCard();
      const { scheduleId } = await freshPlan();

      const result = await withCards(fakePaystack({ card: INVALID_AUTH })).chargeCard(
        { scheduleId, authorizationCode: code, email: 'kofi@x.gh' },
        ACTOR,
      );

      // Paystack refused the request and created no transaction, so there is
      // nothing for the verify poll to find: a failure now, not `unknown`.
      expect(result.status).toBe('failed');
      expect(result.failureReason).toBe('Authorization code is invalid');
      expect((await plans.getInstallment(scheduleId)).status).toBe('failed');

      const card = await cardRow(code);
      expect(card.status).toBe('revoked');
      expect(card.revoked_reason).toContain('invalid_authorization_code');
      // So the next debit cannot pick it, and falls back to Mobile Money.
      expect((await cards.findUsable(customerId))?.authorization_code).not.toBe(code);
    });

    it('leaves the card alone when a charge on it is merely declined', async () => {
      const code = await savedCard();
      const { scheduleId } = await freshPlan();
      const declined = Object.assign(new Error('Charge attempted'), {
        status: 400,
        cause: {
          status: false,
          message: 'Charge attempted',
          data: { reference: 'x', status: 'failed', message: 'Insufficient Funds' },
        },
      });

      const result = await withCards(fakePaystack({ card: declined })).chargeCard(
        { scheduleId, authorizationCode: code, email: 'kofi@x.gh' },
        ACTOR,
      );

      expect(result.status).toBe('failed');
      // An empty account is not a dead card: it may well work next week.
      expect((await cardRow(code)).status).toBe('active');
    });

    it('leaves the card alone when the charge could not be sent', async () => {
      const code = await savedCard();
      const { scheduleId } = await freshPlan();
      const result = await withCards(
        fakePaystack({ card: new Error('socket hang up') }),
      ).chargeCard({ scheduleId, authorizationCode: code, email: 'kofi@x.gh' }, ACTOR);
      expect(result.status).toBe('unknown');
      expect((await cardRow(code)).status).toBe('active');
    });
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

  it('verify still-pending bumps the poll count and parks as unknown at MAX_VERIFY_POLLS', async () => {
    const { scheduleId, attemptId, reference } = await inflightMomoAttempt();
    const svc = service(fakePaystack({ verify: { reference, status: 'pending' } }));

    const first = await svc.verifyAttempt(attemptId, VERIFY_ACTOR);
    expect(first.status).toBe('pending');
    expect(first.attempt.verify_poll_count).toBe(1);

    // Burn the rest of the budget.
    let last = first;
    for (let i = 1; i < MAX_VERIFY_POLLS; i += 1) {
      last = await svc.verifyAttempt(attemptId, VERIFY_ACTOR);
    }

    // Exhausting the budget while Paystack still says "pending" is NOT a
    // failure — we genuinely don't know whether money moved. Recording it as
    // `failed` would classify as retryable and issue a fresh charge on top of
    // a possibly-live one. It parks in `unknown` for the reconciler instead,
    // and the schedule stays `processing` rather than being wrongly failed.
    expect(last.status).toBe('unknown');
    expect(last.attempt.status).toBe('unknown');
    expect(last.attempt.failure_reason).toBe('timeout_no_resolution');
    expect((await plans.getInstallment(scheduleId)).status).toBe('processing');
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

  describe('a decline that rules out one instrument, with another on file', () => {
    // DebitRunner alternates card and Mobile Money down the retry ladder. A
    // decline that kills one instrument used to end the ladder at `overdue`
    // even with the other one on file — so a stale wallet tried as the
    // fallback stranded a usable card, and a blocked card a funded wallet.
    async function customerWithPlan(momo: boolean) {
      const suffix = randomUUID();
      const c = await customers.register(
        {
          first_name: 'Abena',
          last_name: 'Mensah',
          email: `abena+${suffix}@x.gh`,
          phone: `024${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
        },
        ACTOR,
      );
      if (momo) {
        await customers.setMomo(c.id, { momo_phone: '0244999000', momo_provider: 'mtn' }, ACTOR);
      }
      const app = await apps.submit(
        {
          customer_id: c.id,
          merchant_id: merchantId,
          plan_template_id: templateId,
          order_reference: `ORD-${randomUUID()}`,
          order_amount_pesewas: 500_000,
          merchant_category: 'electronics',
        },
        ACTOR,
      );
      await apps.recordDecision(app.id, { outcome: 'approved' }, ACTOR);
      const { schedule } = await plans.activateFromApplication(app.id, ACTOR);
      return { customerId: c.id, scheduleId: schedule[0]!.id };
    }

    function wired(paystack: PaystackChargeClient, retry: RetryScheduler) {
      const cards = new CardAuthorizationService(db);
      return {
        cards,
        svc: new PaymentService(
          plans,
          scheduleState,
          attempts,
          paystack,
          retry,
          undefined,
          undefined,
          undefined,
          cards,
          customers,
        ),
      };
    }

    it('keeps the ladder going after a blocked card when a wallet is on file', async () => {
      const { scheduleId } = await customerWithPlan(true);
      const retry = fakeRetryScheduler();
      const { svc } = wired(
        fakePaystack({
          card: { reference: 'ps_blk2', status: 'failed', gateway_response: 'Blocked Card' },
        }),
        retry,
      );

      await svc.chargeCard({ scheduleId, authorizationCode: 'AUTH_x', email: 'a@x.gh' }, ACTOR);

      expect((await plans.getInstallment(scheduleId)).status).toBe('retry_scheduled');
      expect(retry.jobs).toHaveLength(1);
    });

    it('keeps the ladder going after a closed wallet when a usable card is on file', async () => {
      const { customerId: cid, scheduleId } = await customerWithPlan(true);
      const retry = fakeRetryScheduler();
      const { svc, cards } = wired(
        fakePaystack({
          momo: { reference: 'ps_closed', status: 'failed', gateway_response: 'Account Closed' },
        }),
        retry,
      );
      await cards.record(cid, {
        authorization_code: `AUTH_${randomUUID().slice(0, 8)}`,
        reusable: true,
        last4: '4081',
        brand: 'visa',
        exp_month: '12',
        exp_year: '2099',
      });

      await svc.chargeMobileMoney(
        { scheduleId, email: 'a@x.gh', phone: '+233244999000', provider: 'mtn' },
        ACTOR,
      );

      expect((await plans.getInstallment(scheduleId)).status).toBe('retry_scheduled');
      expect(retry.jobs).toHaveLength(1);
    });

    it('still ends at overdue when there is nothing else to try', async () => {
      const { scheduleId } = await customerWithPlan(false);
      const retry = fakeRetryScheduler();
      const { svc } = wired(
        fakePaystack({
          card: { reference: 'ps_blk3', status: 'failed', gateway_response: 'Blocked Card' },
        }),
        retry,
      );

      await svc.chargeCard({ scheduleId, authorizationCode: 'AUTH_x', email: 'a@x.gh' }, ACTOR);

      expect((await plans.getInstallment(scheduleId)).status).toBe('overdue');
      expect(retry.jobs).toHaveLength(0);
    });
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
