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
import { CollectionsService } from '../collections/collections.service';
import { CustomerPlansService } from '../schedules/customer-plans.service';
import { ScheduleStateService } from '../schedules/schedule-state.service';
import { AttemptRepository } from './attempt-repository';
import { PaymentService, type PaystackChargeClient } from './payment.service';
import { StuckScheduleRunner } from './stuck-schedule-runner';
import { MAX_VERIFY_POLLS } from './retry-policy';

const RUN_DB = Boolean(process.env.DATABASE_URL);
const ALWAYS_OPEN = { set: async () => 'OK' as const, eval: async () => 1 };
const sched = schema.installment_schedule;

/**
 * S4 — nothing gets stuck. Every case here is debt that used to go invisible:
 * no worker looked at it again, so there was no retry, no escalation, no case,
 * and no default. Delinquency reporting silently under-counted it.
 */
describe.skipIf(!RUN_DB)('Stuck-state recovery (integration)', () => {
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
  const collections = new CollectionsService(db, audit, plans);
  const ACTOR = { actorId: SYSTEM_ACTORS.DEBIT_WORKER, actorType: 'worker' as const };
  const RECON = { actorId: SYSTEM_ACTORS.RECONCILER, actorType: 'system' as const };

  let merchantId: string;
  let customerId: string;
  let templateId: string;

  beforeAll(async () => {
    const suffix = randomUUID();
    merchantId = (
      await merchants.create(
        {
          business_name: `SR ${suffix}`,
          legal_name: `SR Ltd ${suffix}`,
          email: `sr+${suffix}@x.gh`,
          phone: `+2332${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
        },
        ACTOR,
      )
    ).id;
    customerId = (
      await customers.register(
        {
          first_name: 'Esi',
          last_name: 'Mensah',
          email: `esi+${suffix}@x.gh`,
          phone: `024${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
        },
        ACTOR,
      )
    ).id;
    templateId = (
      await planTemplates.create(
        {
          name: `BNPL SR ${suffix}`,
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

  async function freshSchedule(): Promise<{ scheduleId: string; planId: string }> {
    const app = await apps.submit(
      {
        customer_id: customerId,
        merchant_id: merchantId,
        plan_template_id: templateId,
        order_reference: `ORD-${randomUUID()}`,
        order_amount_pesewas: 400_000,
        merchant_category: 'electronics',
      },
      ACTOR,
    );
    await apps.recordDecision(app.id, { outcome: 'approved' }, ACTOR);
    const { plan, schedule } = await plans.activateFromApplication(app.id, ACTOR);
    return { scheduleId: schedule[0]!.id, planId: plan.id };
  }

  const statusOf = async (id: string) =>
    (await db.select({ s: sched.status }).from(sched).where(eq(sched.id, id)).limit(1))[0]!.s;

  /**
   * Backdates the schedule so it is sweepable now. Both dates move: there is a
   * CHECK (grace_until_date >= due_date), so grace cannot be moved alone.
   */
  const expireGrace = (id: string) =>
    db
      .update(sched)
      .set({ due_date: '2000-01-01', grace_until_date: '2000-01-02' })
      .where(eq(sched.id, id));

  function paystack(verify: { reference: string; status: string }): PaystackChargeClient {
    return {
      chargeCard: async () => ({ data: { reference: 'x', status: 'success' } }),
      chargeMobileMoney: async () => ({ data: { reference: 'x', status: 'pay_offline' } }),
      verifyTransaction: async () => ({ data: verify }),
    };
  }

  // --- the retry_scheduled black hole -------------------------------------

  it('escalates a retry_scheduled installment past its grace date', async () => {
    const { scheduleId } = await freshSchedule();
    await scheduleState.applyEvent(scheduleId, 'due_date_reached', ACTOR);
    await scheduleState.applyEvent(scheduleId, 'debit_initiated', ACTOR);
    await scheduleState.applyEvent(scheduleId, 'charge_failed', ACTOR);
    await scheduleState.applyEvent(scheduleId, 'retryable', ACTOR);
    expect(await statusOf(scheduleId)).toBe('retry_scheduled');
    await expireGrace(scheduleId);

    // The retry queue is the only owner of retry_scheduled. Reaching the
    // payment-link step and not paying — or simply losing the job — left this
    // row here permanently: no case, no dunning, no write-off, no default.
    const escalated = await collections.escalateGraceExpired(new Date(), ACTOR);
    expect(escalated).toBeGreaterThan(0);
    expect(await statusOf(scheduleId)).toBe('overdue');
  });

  it('escalates a pending installment past its grace date', async () => {
    const { scheduleId } = await freshSchedule();
    expect(await statusOf(scheduleId)).toBe('pending');
    await expireGrace(scheduleId);

    await collections.escalateGraceExpired(new Date(), ACTOR);
    expect(await statusOf(scheduleId)).toBe('overdue');
  });

  it('still escalates due and failed installments', async () => {
    const { scheduleId } = await freshSchedule();
    await scheduleState.applyEvent(scheduleId, 'due_date_reached', ACTOR);
    await expireGrace(scheduleId);
    await collections.escalateGraceExpired(new Date(), ACTOR);
    expect(await statusOf(scheduleId)).toBe('overdue');
  });

  // --- unresolved attempts -------------------------------------------------

  it('includes unknown attempts in the stale sweep, not just in_flight', async () => {
    const { scheduleId, planId } = await freshSchedule();
    const attempt = await attempts.create({
      scheduleId,
      customerPlanId: planId,
      channel: 'auto_debit',
      paymentMethod: 'momo',
      amountPesewas: 100_000,
      idempotencyKey: `${scheduleId}:1`,
      providerReference: `INSTL-${scheduleId}-1`,
    });
    // A network fault during the charge leaves the attempt here.
    await attempts.update(attempt.id, { status: 'unknown' });

    const stale = await attempts.findStaleUnresolved(new Date(Date.now() + 60_000));
    expect(stale.map((a) => a.id)).toContain(attempt.id);
  });

  // --- stuck processing ----------------------------------------------------

  it('resolves a schedule stuck in processing when the provider confirms success', async () => {
    const { scheduleId, planId } = await freshSchedule();
    await scheduleState.applyEvent(scheduleId, 'due_date_reached', ACTOR);
    await scheduleState.applyEvent(scheduleId, 'debit_initiated', ACTOR);
    const reference = `INSTL-${scheduleId}-1`;
    await attempts.create({
      scheduleId,
      customerPlanId: planId,
      channel: 'auto_debit',
      paymentMethod: 'momo',
      amountPesewas: 100_000,
      idempotencyKey: `${scheduleId}:1`,
      providerReference: reference,
    });

    const payments = new PaymentService(
      plans,
      scheduleState,
      attempts,
      paystack({ reference, status: 'success' }),
    );
    const runner = new StuckScheduleRunner(db, attempts, payments);

    const summary = await runner.sweep(new Date(Date.now() + 60_000), RECON);
    expect(summary.resolved).toBeGreaterThan(0);
    expect(await statusOf(scheduleId)).toBe('paid');
  });

  it('flags a processing schedule with no attempt as orphaned', async () => {
    const { scheduleId } = await freshSchedule();
    await scheduleState.applyEvent(scheduleId, 'due_date_reached', ACTOR);
    await scheduleState.applyEvent(scheduleId, 'debit_initiated', ACTOR);

    const alerted: string[] = [];
    const payments = new PaymentService(
      plans,
      scheduleState,
      attempts,
      paystack({ reference: 'x', status: 'success' }),
    );
    const runner = new StuckScheduleRunner(db, attempts, payments, {
      stuck: (d) => void alerted.push(d.scheduleId),
    });

    const summary = await runner.sweep(new Date(Date.now() + 60_000), RECON);
    const mine = summary.outcomes.find((o) => o.scheduleId === scheduleId);
    expect(mine?.outcome).toBe('orphaned');
    expect(alerted).toContain(scheduleId);
  });

  it('names the attempt and its Paystack reference when it cannot resolve one', async () => {
    const { scheduleId, planId } = await freshSchedule();
    await scheduleState.applyEvent(scheduleId, 'due_date_reached', ACTOR);
    await scheduleState.applyEvent(scheduleId, 'debit_initiated', ACTOR);
    const reference = `INSTL-${scheduleId}-1`;
    const attempt = await attempts.create({
      scheduleId,
      customerPlanId: planId,
      channel: 'auto_debit',
      paymentMethod: 'momo',
      amountPesewas: 100_000,
      idempotencyKey: `${scheduleId}:1`,
      providerReference: reference,
    });

    // Paystack cannot be reached: the attempt stays unresolved.
    const unreachable: PaystackChargeClient = {
      ...paystack({ reference, status: 'success' }),
      verifyTransaction: async () => {
        throw new Error('connect ETIMEDOUT');
      },
    };
    const alerts: Array<Record<string, unknown>> = [];
    const runner = new StuckScheduleRunner(
      db,
      attempts,
      new PaymentService(plans, scheduleState, attempts, unreachable),
      { stuck: (d) => void alerts.push(d) },
    );

    await runner.sweep(new Date(Date.now() + 60_000), RECON);
    // The console shows no attempts; the alert is where the reference has to be.
    expect(alerts.find((a) => a.scheduleId === scheduleId)).toMatchObject({
      outcome: 'unresolved',
      attemptId: attempt.id,
      providerReference: reference,
    });
  });

  // --- verify budget -------------------------------------------------------

  it('parks an attempt in unknown when the verify budget runs out, never failed', async () => {
    const { scheduleId, planId } = await freshSchedule();
    await scheduleState.applyEvent(scheduleId, 'due_date_reached', ACTOR);
    await scheduleState.applyEvent(scheduleId, 'debit_initiated', ACTOR);
    const reference = `INSTL-${scheduleId}-1`;
    const attempt = await attempts.create({
      scheduleId,
      customerPlanId: planId,
      channel: 'auto_debit',
      paymentMethod: 'momo',
      amountPesewas: 100_000,
      idempotencyKey: `${scheduleId}:1`,
      providerReference: reference,
    });
    await attempts.update(attempt.id, { verifyPollCount: MAX_VERIFY_POLLS - 1 });

    const payments = new PaymentService(
      plans,
      scheduleState,
      attempts,
      paystack({ reference, status: 'pending' }),
    );

    // Recording this as `failed` would classify as retryable and issue a fresh
    // charge while the customer's original MoMo prompt may still be live.
    const result = await payments.verifyAttempt(attempt.id, RECON);
    expect(result.status).toBe('unknown');
    expect(result.attempt.status).toBe('unknown');
    expect(await statusOf(scheduleId)).toBe('processing');
  });

  it('gives MoMo a realistic approval window before giving up', () => {
    // Regression guard: the budget was 2 polls (~10 min) against a ~45 min
    // design, which turned "we don't know" into "failed" mid-approval.
    expect(MAX_VERIFY_POLLS).toBeGreaterThanOrEqual(6);
  });
});
