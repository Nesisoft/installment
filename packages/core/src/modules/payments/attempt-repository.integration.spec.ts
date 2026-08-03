import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '@installment/db';
import { AuditLogger } from '../audit/audit-logger.service';
import { SYSTEM_ACTORS } from '../../shared/constants/system-actors';
import { MerchantsService } from '../merchants/merchants.service';
import { CustomersService } from '../customers/customers.service';
import { MockGhanaCardVerifier } from '../customers/ghana-card-verifier';
import { PlanTemplatesService } from '../plans/plan-templates.service';
import { ApplicationsService } from '../applications/applications.service';
import { CustomerPlansService } from '../schedules/customer-plans.service';
import { AttemptRepository } from './attempt-repository';
import { PaymentAttemptNotFoundError } from './errors';

const RUN_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!RUN_DB)('AttemptRepository (integration)', () => {
  const { db, pool } = createTestDb();
  const audit = new AuditLogger();
  const merchants = new MerchantsService(db, audit);
  const customers = new CustomersService(db, audit, new MockGhanaCardVerifier());
  const planTemplates = new PlanTemplatesService(db, audit);
  const apps = new ApplicationsService(db, audit);
  const plans = new CustomerPlansService(db, audit);
  const attempts = new AttemptRepository(db);
  const ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  let scheduleId: string;
  let planId: string;

  beforeAll(async () => {
    const suffix = randomUUID();
    const merchant = await merchants.create(
      {
        business_name: `M ${suffix}`,
        legal_name: `M Ltd ${suffix}`,
        email: `m+${suffix}@x.gh`,
        phone: '+233244000000',
      },
      ACTOR,
    );
    const customer = await customers.register(
      {
        first_name: 'Kofi',
        last_name: 'Owusu',
        email: `kofi+${suffix}@x.gh`,
        phone: `024${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
      },
      ACTOR,
    );
    const template = await planTemplates.create(
      {
        name: `BNPL ${suffix}`,
        business_model: 'bnpl',
        number_of_installments: 4,
        installment_frequency_days: 7,
        min_amount_pesewas: 1_000,
        max_amount_pesewas: 10_000_000,
      },
      ACTOR,
    );
    const app = await apps.submit(
      {
        customer_id: customer.id,
        merchant_id: merchant.id,
        plan_template_id: template.id,
        order_reference: `ORD-${randomUUID()}`,
        order_amount_pesewas: 500_000,
        merchant_category: 'electronics',
      },
      ACTOR,
    );
    await apps.recordDecision(app.id, { outcome: 'approved' }, ACTOR);
    const { plan, schedule } = await plans.activateFromApplication(app.id, ACTOR);
    planId = plan.id;
    scheduleId = schedule[0]!.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  it('creates an in-flight attempt and resolves it to succeeded', async () => {
    const key = `${scheduleId}:1`;
    const created = await attempts.create({
      scheduleId,
      customerPlanId: planId,
      channel: 'auto_debit',
      paymentMethod: 'card',
      amountPesewas: 125_000,
      idempotencyKey: key,
    });
    expect(created.status).toBe('in_flight');
    expect(created.provider).toBe('paystack');

    const ref = `ps_${randomUUID()}`;
    const settled = await attempts.update(created.id, {
      status: 'succeeded',
      providerReference: ref,
      rawResponse: { status: 'success' },
      settledAt: new Date(),
    });
    expect(settled.status).toBe('succeeded');
    expect(settled.settled_at).not.toBeNull();

    expect((await attempts.findById(created.id))?.status).toBe('succeeded');
    expect((await attempts.findByProviderReference(ref))?.id).toBe(created.id);
    expect((await attempts.findByIdempotencyKey(key))?.id).toBe(created.id);
  });

  it('throws when updating an unknown attempt', async () => {
    await expect(attempts.update(randomUUID(), { status: 'failed' })).rejects.toBeInstanceOf(
      PaymentAttemptNotFoundError,
    );
  });

  it('findStaleInFlight returns only in-flight attempts older than the cutoff', async () => {
    const inFlight = await attempts.create({
      scheduleId,
      customerPlanId: planId,
      channel: 'auto_debit',
      paymentMethod: 'momo',
      amountPesewas: 125_000,
      idempotencyKey: `${scheduleId}:stale-1`,
    });
    const resolved = await attempts.create({
      scheduleId,
      customerPlanId: planId,
      channel: 'auto_debit',
      paymentMethod: 'momo',
      amountPesewas: 125_000,
      idempotencyKey: `${scheduleId}:stale-2`,
    });
    await attempts.update(resolved.id, { status: 'succeeded', settledAt: new Date() });

    // A cutoff just after creation catches the in-flight one (initiated_at < cutoff)…
    const future = new Date(Date.now() + 60_000);
    const stale = await attempts.findStaleInFlight(future);
    const ids = stale.map((a) => a.id);
    expect(ids).toContain(inFlight.id);
    expect(ids).not.toContain(resolved.id); // succeeded, excluded

    // …and a cutoff in the past excludes a freshly-created attempt.
    const past = new Date(Date.now() - 60_000);
    const noneYet = await attempts.findStaleInFlight(past);
    expect(noneYet.map((a) => a.id)).not.toContain(inFlight.id);
  });
});
