import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
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
import { CustomerPlansService } from './customer-plans.service';
import { ScheduleStateService } from './schedule-state.service';
import { IllegalScheduleTransitionError, ScheduleTerminalStateError } from './state-machine';

const RUN_DB = Boolean(process.env.DATABASE_URL);

// A lock client that always acquires — lock semantics are covered by redis-lock.spec.
const ALWAYS_OPEN = {
  set: async () => 'OK' as const,
  eval: async () => 1,
};

describe.skipIf(!RUN_DB)('ScheduleStateService (integration)', () => {
  const { db, pool } = createDb({ connectionString: process.env.DATABASE_URL! });
  const audit = new AuditLogger();
  const merchants = new MerchantsService(db, audit);
  const customers = new CustomersService(db, audit, new MockGhanaCardVerifier());
  const planTemplates = new PlanTemplatesService(db, audit);
  const apps = new ApplicationsService(db, audit);
  const plans = new CustomerPlansService(db, audit);
  const bus = new EventBus();
  const state = new ScheduleStateService(db, audit, new RedisLock(ALWAYS_OPEN), bus);
  const WORKER = { actorId: SYSTEM_ACTORS.DEBIT_WORKER, actorType: 'worker' as const };

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
        WORKER,
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
        WORKER,
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
        WORKER,
      )
    ).id;
  });

  afterAll(async () => {
    await pool.end();
  });

  async function freshSchedule(): Promise<string[]> {
    const app = await apps.submit(
      {
        customer_id: customerId,
        merchant_id: merchantId,
        plan_template_id: templateId,
        order_reference: `ORD-${randomUUID()}`,
        order_amount_pesewas: 100_000,
        merchant_category: 'electronics',
      },
      WORKER,
    );
    await apps.recordDecision(app.id, { outcome: 'approved' }, WORKER);
    const { schedule } = await plans.activateFromApplication(app.id, WORKER);
    return schedule.map((r) => r.id);
  }

  async function lastScheduleEvent(scheduleId: string): Promise<string | undefined> {
    const rows = await db
      .select({ event_type: schema.audit_events.event_type })
      .from(schema.audit_events)
      .where(
        and(
          eq(schema.audit_events.entity_id, scheduleId),
          eq(schema.audit_events.entity_type, 'installment_schedule'),
        ),
      )
      .orderBy(desc(schema.audit_events.occurred_at))
      .limit(1);
    return rows[0]?.event_type;
  }

  it('walks an installment pending → due → processing → paid and publishes events', async () => {
    const [scheduleId] = await freshSchedule();
    const paidEvents: unknown[] = [];
    const unsub = bus.subscribe('schedule.paid', (p) => {
      paidEvents.push(p);
    });

    expect((await state.applyEvent(scheduleId!, 'due_date_reached', WORKER)).to).toBe('due');

    const processing = await state.applyEvent(scheduleId!, 'debit_initiated', WORKER);
    expect(processing.to).toBe('processing');
    expect(processing.row.attempt_count).toBe(1);
    expect(processing.row.last_attempt_at).not.toBeNull();

    const paid = await state.applyEvent(scheduleId!, 'charge_succeeded', {
      ...WORKER,
      providerReference: 'ps_ref_1',
    });
    expect(paid.to).toBe('paid');
    expect(paid.row.paid_at).not.toBeNull();
    expect(paid.row.provider_reference).toBe('ps_ref_1');

    expect(await lastScheduleEvent(scheduleId!)).toBe('schedule.charge_succeeded');
    expect(paidEvents).toHaveLength(1);
    unsub();
  });

  it('rejects an illegal transition', async () => {
    const [scheduleId] = await freshSchedule();
    await expect(state.applyEvent(scheduleId!, 'charge_succeeded', WORKER)).rejects.toBeInstanceOf(
      IllegalScheduleTransitionError,
    );
  });

  it('refunds a paid installment, then blocks further transitions', async () => {
    const [scheduleId] = await freshSchedule();
    await state.applyEvent(scheduleId!, 'due_date_reached', WORKER);
    await state.applyEvent(scheduleId!, 'debit_initiated', WORKER);
    await state.applyEvent(scheduleId!, 'charge_succeeded', WORKER);

    expect((await state.applyEvent(scheduleId!, 'refund_issued', WORKER)).to).toBe('refunded');
    await expect(state.applyEvent(scheduleId!, 'due_date_reached', WORKER)).rejects.toBeInstanceOf(
      ScheduleTerminalStateError,
    );
  });
});
