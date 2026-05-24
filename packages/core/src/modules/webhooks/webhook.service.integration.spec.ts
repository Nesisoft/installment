import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
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
import { WebhookService } from './webhook.service';
import { WebhookSignatureError } from './errors';

const RUN_DB = Boolean(process.env.DATABASE_URL);
const ALWAYS_OPEN = { set: async () => 'OK' as const, eval: async () => 1 };
const ACCEPT = { verifySignature: () => true };
const REJECT = { verifySignature: () => false };

describe.skipIf(!RUN_DB)('WebhookService (integration)', () => {
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
  const webhooks = new WebhookService(db, ACCEPT, attempts, plans, scheduleState);
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

  /** A schedule driven to `processing` with an in-flight attempt under a known reference. */
  async function processingAttempt(): Promise<{
    scheduleId: string;
    planId: string;
    reference: string;
  }> {
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
    const scheduleId = schedule[0]!.id;
    await scheduleState.applyEvent(scheduleId, 'due_date_reached', ACTOR);
    await scheduleState.applyEvent(scheduleId, 'debit_initiated', ACTOR);
    const reference = `INSTL-${scheduleId}-${randomUUID()}`;
    await attempts.create({
      scheduleId,
      customerPlanId: plan.id,
      channel: 'auto_debit',
      paymentMethod: 'card',
      amountPesewas: 125_000,
      idempotencyKey: `${scheduleId}:1`,
      providerReference: reference,
    });
    return { scheduleId, planId: plan.id, reference };
  }

  it('rejects a webhook with a bad signature', async () => {
    const rejecting = new WebhookService(db, REJECT, attempts, plans, scheduleState);
    await expect(rejecting.ingest('{}', 'bad')).rejects.toBeInstanceOf(WebhookSignatureError);
  });

  it('settles the schedule on charge.success and is a no-op on replay', async () => {
    const { scheduleId, planId, reference } = await processingAttempt();
    const raw = JSON.stringify({ event: 'charge.success', data: { reference, status: 'success' } });

    const first = await webhooks.ingest(raw, 'sig');
    expect(first.processed).toBe(true);
    expect((await plans.getInstallment(scheduleId)).status).toBe('paid');
    expect((await plans.get(planId)).outstanding_pesewas).toBe(375_000);
    expect((await attempts.findByProviderReference(reference))?.status).toBe('succeeded');

    // Replay of the same event is a no-op.
    const replay = await webhooks.ingest(raw, 'sig');
    expect(replay.processed).toBe(false);
    expect((await plans.get(planId)).outstanding_pesewas).toBe(375_000); // unchanged

    const stored = (
      await db
        .select()
        .from(schema.webhook_events)
        .where(
          and(
            eq(schema.webhook_events.provider, 'paystack'),
            eq(schema.webhook_events.provider_event_id, `charge.success:${reference}`),
          ),
        )
        .limit(1)
    )[0];
    expect(stored?.processed_at).not.toBeNull();
  });

  it('records a decline on charge.failed', async () => {
    const { scheduleId, reference } = await processingAttempt();
    const raw = JSON.stringify({
      event: 'charge.failed',
      data: { reference, status: 'failed', gateway_response: 'insufficient_funds' },
    });

    const result = await webhooks.ingest(raw, 'sig');
    expect(result.processed).toBe(true);
    expect((await plans.getInstallment(scheduleId)).status).toBe('failed');
    expect((await attempts.findByProviderReference(reference))?.status).toBe('failed');
  });

  it('ignores an event for an unknown reference', async () => {
    const raw = JSON.stringify({
      event: 'charge.success',
      data: { reference: `unknown-${randomUUID()}` },
    });
    const result = await webhooks.ingest(raw, 'sig');
    expect(result.processed).toBe(true); // recorded, but dispatch found nothing to do
  });
});
