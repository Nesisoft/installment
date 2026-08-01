import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, schema } from '@installment/db';
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
import { AttemptRepository } from '../payments/attempt-repository';
import { ChargeFailureEscalator } from '../payments/charge-failure-escalator';
import type { RetryJob, RetryScheduler } from '../payments/retry-scheduler';
import { WebhookService, type WebhookAlertSink } from './webhook.service';

const RUN_DB = Boolean(process.env.DATABASE_URL);
const ALWAYS_OPEN = { set: async () => 'OK' as const, eval: async () => 1 };
const ACCEPT = { verifySignature: () => true };
const sched = schema.installment_schedule;

type Alert = Parameters<WebhookAlertSink['unhandled']>[0];

function recordingAlerts(): WebhookAlertSink & { seen: Alert[] } {
  const seen: Alert[] = [];
  return { seen, unhandled: (d) => void seen.push(d) };
}

function recordingScheduler(): RetryScheduler & { jobs: RetryJob[] } {
  const jobs: RetryJob[] = [];
  return { jobs, scheduleRetry: async (job) => void jobs.push(job) };
}

/**
 * S3 — async completion parity. Every case here is money that the engine used
 * to take from a customer and then discard, because the state machine had
 * exactly one path to `paid` (`processing:charge_succeeded`) and the webhook
 * swallowed anything it could not apply.
 */
describe.skipIf(!RUN_DB)('Async settlement via webhook (integration)', () => {
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
          business_name: `AS ${suffix}`,
          legal_name: `AS Ltd ${suffix}`,
          email: `as+${suffix}@x.gh`,
          phone: `+2332${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
        },
        ACTOR,
      )
    ).id;
    customerId = (
      await customers.register(
        {
          first_name: 'Yaw',
          last_name: 'Darko',
          email: `yaw+${suffix}@x.gh`,
          phone: `024${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
        },
        ACTOR,
      )
    ).id;
    templateId = (
      await planTemplates.create(
        {
          name: `BNPL AS ${suffix}`,
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

  function service(opts: { escalator?: ChargeFailureEscalator; alerts?: WebhookAlertSink } = {}) {
    return new WebhookService(
      db,
      ACCEPT,
      attempts,
      plans,
      scheduleState,
      opts.escalator,
      opts.alerts,
    );
  }

  const body = (event: string, reference: string, gateway?: string) =>
    JSON.stringify({ event, data: { reference, gateway_response: gateway } });

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

  /** Records an attempt row under `reference` without moving the schedule. */
  async function attemptFor(scheduleId: string, planId: string, reference: string) {
    return attempts.create({
      scheduleId,
      customerPlanId: planId,
      channel: 'payment_link',
      paymentMethod: 'momo',
      amountPesewas: 100_000,
      idempotencyKey: `${scheduleId}:${randomUUID()}`,
      providerReference: reference,
    });
  }

  const statusOf = async (scheduleId: string) =>
    (await db.select({ s: sched.status }).from(sched).where(eq(sched.id, scheduleId)).limit(1))[0]!
      .s;

  async function driveTo(scheduleId: string, target: 'retry_scheduled' | 'failed' | 'overdue') {
    await scheduleState.applyEvent(scheduleId, 'due_date_reached', ACTOR);
    await scheduleState.applyEvent(scheduleId, 'debit_initiated', ACTOR);
    await scheduleState.applyEvent(scheduleId, 'charge_failed', ACTOR);
    if (target === 'failed') return;
    if (target === 'overdue') {
      await scheduleState.applyEvent(scheduleId, 'non_retryable_decline', ACTOR);
      return;
    }
    await scheduleState.applyEvent(scheduleId, 'retryable', ACTOR);
  }

  it('settles a payment-link payment made while the schedule sits in retry_scheduled', async () => {
    const { scheduleId, planId } = await freshSchedule();
    await driveTo(scheduleId, 'retry_scheduled');
    const reference = `LINK-${randomUUID()}`;
    await attemptFor(scheduleId, planId, reference);

    // This is the engine's designed final fallback. Before S3 the success was
    // an illegal transition from retry_scheduled and was silently swallowed:
    // customer paid, installment stayed unpaid, dunning continued.
    const res = await service().ingest(body('charge.success', reference), 'sig');
    expect(res.processed).toBe(true);
    expect(await statusOf(scheduleId)).toBe('paid');
  });

  it('settles a late MoMo approval that lands after the schedule was failed', async () => {
    const { scheduleId, planId } = await freshSchedule();
    await driveTo(scheduleId, 'failed');
    const reference = `INSTL-${randomUUID()}-1`;
    await attemptFor(scheduleId, planId, reference);

    await service().ingest(body('charge.success', reference), 'sig');
    expect(await statusOf(scheduleId)).toBe('paid');
  });

  it('settles a payment that arrives after escalation to overdue', async () => {
    const { scheduleId, planId } = await freshSchedule();
    await driveTo(scheduleId, 'overdue');
    const reference = `LINK-${randomUUID()}`;
    await attemptFor(scheduleId, planId, reference);

    await service().ingest(body('charge.success', reference), 'sig');
    expect(await statusOf(scheduleId)).toBe('paid');
  });

  it('reduces the plan outstanding when a late payment settles', async () => {
    const { scheduleId, planId } = await freshSchedule();
    const before = (await plans.get(planId)).outstanding_pesewas;
    await driveTo(scheduleId, 'retry_scheduled');
    const reference = `LINK-${randomUUID()}`;
    await attemptFor(scheduleId, planId, reference);

    await service().ingest(body('charge.success', reference), 'sig');
    expect((await plans.get(planId)).outstanding_pesewas).toBeLessThan(before);
  });

  it('runs the retry ladder for a webhook-delivered failure', async () => {
    const { scheduleId, planId } = await freshSchedule();
    await scheduleState.applyEvent(scheduleId, 'due_date_reached', ACTOR);
    await scheduleState.applyEvent(scheduleId, 'debit_initiated', ACTOR);
    const reference = `INSTL-${randomUUID()}-1`;
    await attemptFor(scheduleId, planId, reference);

    const scheduler = recordingScheduler();
    const escalator = new ChargeFailureEscalator(plans, scheduleState, scheduler);

    // MoMo's real path: the sync call returned pay_offline, the decline arrives
    // by webhook. Before S3 this stopped at `charge_failed` — no retry was ever
    // enqueued and the payment-link fallback never fired.
    await service({ escalator }).ingest(
      body('charge.failed', reference, 'Insufficient funds'),
      'sig',
    );

    expect(await statusOf(scheduleId)).toBe('retry_scheduled');
    expect(scheduler.jobs).toHaveLength(1);
    expect(scheduler.jobs[0]!.scheduleId).toBe(scheduleId);
  });

  it('alerts instead of silently dropping a webhook for an untracked reference', async () => {
    const alerts = recordingAlerts();
    const res = await service({ alerts }).ingest(
      body('charge.success', `UNKNOWN-${randomUUID()}`),
      'sig',
    );

    expect(res.processed).toBe(true);
    expect(alerts.seen).toHaveLength(1);
    expect(alerts.seen[0]!.reason).toMatch(/no payment_attempt/);
  });

  it('ignores a late failure for an attempt already recorded as succeeded', async () => {
    const { scheduleId, planId } = await freshSchedule();
    await driveTo(scheduleId, 'retry_scheduled');
    const reference = `LINK-${randomUUID()}`;
    await attemptFor(scheduleId, planId, reference);
    await service().ingest(body('charge.success', reference), 'sig');
    expect(await statusOf(scheduleId)).toBe('paid');

    // An out-of-order charge.failed for the same (now settled) reference must
    // not downgrade a paid installment.
    const alerts = recordingAlerts();
    await service({ alerts }).ingest(body('charge.failed', reference, 'Declined'), 'sig');

    expect(await statusOf(scheduleId)).toBe('paid');
    expect(alerts.seen[0]!.reason).toMatch(/already recorded as succeeded/);
  });

  it('treats a re-delivered success for an already-paid schedule as a benign no-op', async () => {
    const { scheduleId, planId } = await freshSchedule();
    await driveTo(scheduleId, 'retry_scheduled');
    const reference = `LINK-${randomUUID()}`;
    await attemptFor(scheduleId, planId, reference);
    await service().ingest(body('charge.success', reference), 'sig');

    // Paystack re-delivers. The webhook_events dedupe swallows the exact
    // replay, so force the handler to run again via a distinct event id.
    await db
      .update(schema.webhook_events)
      .set({ processed_at: null })
      .where(eq(schema.webhook_events.provider_event_id, `charge.success:${reference}`));

    const alerts = recordingAlerts();
    await expect(
      service({ alerts }).ingest(body('charge.success', reference), 'sig'),
    ).resolves.toBeTruthy();
    expect(await statusOf(scheduleId)).toBe('paid');
    expect(alerts.seen).toHaveLength(0); // benign — must not page anyone
  });
});
