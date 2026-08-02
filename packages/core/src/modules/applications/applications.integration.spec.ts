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
import { ApplicationsService } from './applications.service';
import { ApplicationNotFoundError, DuplicateApplicationError } from './errors';
import { IllegalApplicationTransitionError } from './state-machine';

const RUN_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!RUN_DB)('ApplicationsService (integration)', () => {
  const { db, pool } = createDb({ connectionString: process.env.DATABASE_URL! });
  const audit = new AuditLogger();
  const apps = new ApplicationsService(db, audit);
  const merchants = new MerchantsService(db, audit);
  const customers = new CustomersService(db, audit, new MockGhanaCardVerifier());
  const plans = new PlanTemplatesService(db, audit);
  const SYSTEM_ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  let customerId: string;
  let merchantId: string;
  let planTemplateId: string;

  beforeAll(async () => {
    const suffix = randomUUID();
    const merchant = await merchants.create(
      {
        business_name: `M ${suffix}`,
        legal_name: `M Ltd ${suffix}`,
        email: `m+${suffix}@x.gh`,
        phone: '+233244000000',
      },
      SYSTEM_ACTOR,
    );
    merchantId = merchant.id;
    const customer = await customers.register(
      {
        first_name: 'Ama',
        last_name: 'M',
        email: `ama+${suffix}@x.gh`,
        // Randomised: customers.phone is UNIQUE, so a hardcoded number makes
        // this suite pass only against a virgin database and fail on every
        // local re-run.
        phone: `024${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
      },
      SYSTEM_ACTOR,
    );
    customerId = customer.id;
    const plan = await plans.create(
      {
        name: `BNPL ${suffix}`,
        business_model: 'bnpl',
        number_of_installments: 4,
        installment_frequency_days: 7,
        min_amount_pesewas: 1_000,
        max_amount_pesewas: 10_000_000,
      },
      SYSTEM_ACTOR,
    );
    planTemplateId = plan.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  function submitInput(orderRef = `ORD-${randomUUID()}`) {
    return {
      customer_id: customerId,
      merchant_id: merchantId,
      plan_template_id: planTemplateId,
      order_reference: orderRef,
      order_amount_pesewas: 500_000,
      merchant_category: 'electronics',
    };
  }

  async function lastEventType(id: string): Promise<string | undefined> {
    const rows = await db
      .select({ event_type: schema.audit_events.event_type })
      .from(schema.audit_events)
      .where(
        and(
          eq(schema.audit_events.entity_id, id),
          eq(schema.audit_events.entity_type, 'application'),
        ),
      )
      .orderBy(desc(schema.audit_events.occurred_at))
      .limit(1);
    return rows[0]?.event_type;
  }

  it('submits a pending application and audits it', async () => {
    const app = await apps.submit(submitInput(), SYSTEM_ACTOR);
    expect(app.status).toBe('pending');
    expect(app.decision_at).toBeNull();
    expect(await lastEventType(app.id)).toBe('application.submitted');
  });

  it('rejects a duplicate (merchant_id, order_reference)', async () => {
    const input = submitInput();
    await apps.submit(input, SYSTEM_ACTOR);
    await expect(apps.submit(input, SYSTEM_ACTOR)).rejects.toBeInstanceOf(
      DuplicateApplicationError,
    );
  });

  it('records an approved decision', async () => {
    const app = await apps.submit(submitInput(), SYSTEM_ACTOR);
    const decided = await apps.recordDecision(app.id, { outcome: 'approved' }, SYSTEM_ACTOR);
    expect(decided.status).toBe('approved');
    expect(decided.decision_at).not.toBeNull();
    expect(await lastEventType(app.id)).toBe('application.approve');
  });

  it('records a counter-offer and accepts it', async () => {
    const app = await apps.submit(submitInput(), SYSTEM_ACTOR);
    const countered = await apps.recordDecision(
      app.id,
      {
        outcome: 'counter_offer',
        counter_down_payment_pesewas: 150_000,
        counter_financed_pesewas: 350_000,
      },
      SYSTEM_ACTOR,
    );
    expect(countered.status).toBe('counter_offered');
    expect(countered.counter_down_payment_pesewas).toBe(150_000);
    expect(countered.counter_financed_pesewas).toBe(350_000);

    const accepted = await apps.acceptCounterOffer(app.id, SYSTEM_ACTOR);
    expect(accepted.status).toBe('approved');
    expect(await lastEventType(app.id)).toBe('application.accept_counter');
  });

  it('records a decline with a reason', async () => {
    const app = await apps.submit(submitInput(), SYSTEM_ACTOR);
    const declined = await apps.recordDecision(
      app.id,
      { outcome: 'declined', declined_reason: 'Recent default on file' },
      SYSTEM_ACTOR,
    );
    expect(declined.status).toBe('declined');
    expect(declined.declined_reason).toBe('Recent default on file');
  });

  it('refers to manual_review then approves from there', async () => {
    const app = await apps.submit(submitInput(), SYSTEM_ACTOR);
    const referred = await apps.recordDecision(app.id, { outcome: 'manual_review' }, SYSTEM_ACTOR);
    expect(referred.status).toBe('manual_review');
    const approved = await apps.recordDecision(app.id, { outcome: 'approved' }, SYSTEM_ACTOR);
    expect(approved.status).toBe('approved');
  });

  it('rejects a decision on a terminal application', async () => {
    const app = await apps.submit(submitInput(), SYSTEM_ACTOR);
    await apps.recordDecision(app.id, { outcome: 'approved' }, SYSTEM_ACTOR);
    await expect(
      apps.recordDecision(app.id, { outcome: 'declined' }, SYSTEM_ACTOR),
    ).rejects.toBeInstanceOf(IllegalApplicationTransitionError);
  });

  it('cancels a pending application', async () => {
    const app = await apps.submit(submitInput(), SYSTEM_ACTOR);
    const cancelled = await apps.cancel(app.id, SYSTEM_ACTOR);
    expect(cancelled.status).toBe('cancelled');
  });

  it('expires only the overdue non-terminal applications', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const overdue = await apps.submit({ ...submitInput(), expires_at: past }, SYSTEM_ACTOR);
    const fresh = await apps.submit({ ...submitInput(), expires_at: future }, SYSTEM_ACTOR);

    const count = await apps.expireOverdue(new Date(), SYSTEM_ACTOR);
    expect(count).toBeGreaterThanOrEqual(1);
    expect((await apps.get(overdue.id)).status).toBe('expired');
    expect((await apps.get(fresh.id)).status).toBe('pending');
  });

  it('lists by merchant / customer / status and throws on unknown id', async () => {
    const app = await apps.submit(submitInput(), SYSTEM_ACTOR);
    expect((await apps.list({ merchant_id: merchantId, limit: 200 })).map((r) => r.id)).toContain(
      app.id,
    );
    expect(
      (await apps.list({ customer_id: customerId, status: 'pending', limit: 200 })).length,
    ).toBeGreaterThan(0);
    await expect(apps.get(randomUUID())).rejects.toBeInstanceOf(ApplicationNotFoundError);
  });
});
