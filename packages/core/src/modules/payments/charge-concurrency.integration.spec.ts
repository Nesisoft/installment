import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '@installment/db';
import { AuditLogger } from '../audit/audit-logger.service';
import { EventBus } from '../../shared/event-bus/event-bus';
import { RedisLock, type RedisLockClient } from '../../shared/lock/redis-lock';
import { SYSTEM_ACTORS } from '../../shared/constants/system-actors';
import { MerchantsService } from '../merchants/merchants.service';
import { CustomersService } from '../customers/customers.service';
import { MockGhanaCardVerifier } from '../customers/ghana-card-verifier';
import { PlanTemplatesService } from '../plans/plan-templates.service';
import { ApplicationsService } from '../applications/applications.service';
import { CustomerPlansService } from '../schedules/customer-plans.service';
import { PlanAlreadyActiveError } from '../schedules/errors';
import { ScheduleStateService } from '../schedules/schedule-state.service';
import { AttemptRepository } from './attempt-repository';
import { ChargeAlreadyInFlightError } from './errors';
import { PaymentService, type PaystackChargeClient } from './payment.service';

const RUN_DB = Boolean(process.env.DATABASE_URL);

/**
 * A faithful in-memory implementation of the two Redis commands RedisLock uses:
 * `SET key val PX ttl NX` and the compare-and-delete release script. Unlike the
 * `ALWAYS_OPEN` stubs used elsewhere in this suite — which return 'OK'
 * unconditionally and therefore make every lock a no-op — this one really
 * enforces mutual exclusion, so a test that depends on the lock can actually
 * fail. That is the whole point of this file.
 */
function contendedLockClient(): RedisLockClient {
  const keys = new Map<string, { token: string; expiresAt: number }>();
  return {
    async set(key, value, _mode, ttlMs, _condition) {
      const existing = keys.get(key);
      if (existing && existing.expiresAt > Date.now()) return null; // NX: held
      keys.set(key, { token: value, expiresAt: Date.now() + ttlMs });
      return 'OK';
    },
    async eval(_script, _numKeys, ...args) {
      const [key, token] = args as [string, string];
      const existing = keys.get(key);
      if (existing && existing.token === token) {
        keys.delete(key);
        return 1;
      }
      return 0;
    },
  };
}

/** Counts provider calls so "how many times was the customer charged?" is directly assertable. */
function countingPaystack(status: string): PaystackChargeClient & { momoCalls: string[] } {
  const momoCalls: string[] = [];
  return {
    momoCalls,
    chargeMobileMoney: async (req: { reference: string }) => {
      momoCalls.push(req.reference);
      return { data: { reference: `ps_${momoCalls.length}`, status } };
    },
    chargeCard: async () => {
      throw new Error('chargeCard not stubbed');
    },
    verifyTransaction: async () => {
      throw new Error('verifyTransaction not stubbed');
    },
  } as PaystackChargeClient & { momoCalls: string[] };
}

describe.skipIf(!RUN_DB)('Charge concurrency (integration)', () => {
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
    new RedisLock(contendedLockClient()),
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
          business_name: `CC ${suffix}`,
          legal_name: `CC Ltd ${suffix}`,
          email: `cc+${suffix}@x.gh`,
          phone: `+2332${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
        },
        ACTOR,
      )
    ).id;
    customerId = (
      await customers.register(
        {
          first_name: 'Adwoa',
          last_name: 'Boateng',
          email: `adwoa+${suffix}@x.gh`,
          phone: `024${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
        },
        ACTOR,
      )
    ).id;
    templateId = (
      await planTemplates.create(
        {
          name: `BNPL CC ${suffix}`,
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

  async function approvedApplication(): Promise<string> {
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
    return app.id;
  }

  async function freshSchedule(): Promise<string> {
    const { schedule } = await plans.activateFromApplication(await approvedApplication(), ACTOR);
    return schedule[0]!.id;
  }

  function service(paystack: PaystackChargeClient, lock?: RedisLock): PaymentService {
    return new PaymentService(
      plans,
      scheduleState,
      attempts,
      paystack,
      undefined,
      undefined,
      undefined,
      lock,
    );
  }

  it('charges once and refuses a second charge while the first is still in flight', async () => {
    const scheduleId = await freshSchedule();
    const paystack = countingPaystack('pay_offline'); // MoMo's normal async path
    const svc = service(paystack);

    const first = await svc.chargeMobileMoney(
      { scheduleId, email: 'adwoa@x.gh', phone: '+233244000111', provider: 'mtn' },
      ACTOR,
    );
    expect(first.status).toBe('pending');

    // The customer taps "Pay" again while the MoMo prompt is still on their handset.
    await expect(
      svc.chargeMobileMoney(
        { scheduleId, email: 'adwoa@x.gh', phone: '+233244000111', provider: 'mtn' },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(ChargeAlreadyInFlightError);

    expect(paystack.momoCalls).toHaveLength(1);
  });

  it('two concurrent charges produce exactly one debit', async () => {
    const scheduleId = await freshSchedule();
    const paystack = countingPaystack('pay_offline');
    const svc = service(paystack, new RedisLock(contendedLockClient()));

    const results = await Promise.allSettled([
      svc.chargeMobileMoney(
        { scheduleId, email: 'adwoa@x.gh', phone: '+233244000111', provider: 'mtn' },
        ACTOR,
      ),
      svc.chargeMobileMoney(
        { scheduleId, email: 'adwoa@x.gh', phone: '+233244000111', provider: 'mtn' },
        ACTOR,
      ),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // Whichever guard caught it, the customer must not be debited twice.
    expect(paystack.momoCalls).toHaveLength(1);
  });

  it('sends Paystack a reference within its documented charset', async () => {
    const scheduleId = await freshSchedule();
    const paystack = countingPaystack('pay_offline');
    await service(paystack).chargeMobileMoney(
      { scheduleId, email: 'adwoa@x.gh', phone: '+233244000111', provider: 'mtn' },
      ACTOR,
    );

    const reference = paystack.momoCalls[0]!;
    expect(reference).toMatch(/^[A-Za-z0-9.=-]{1,100}$/);
    expect(reference).not.toContain(':');
    expect(reference).toBe(`INSTL-${scheduleId}-1`);
  });

  it('records the attempt under a colon-joined idempotency key distinct from the reference', async () => {
    const scheduleId = await freshSchedule();
    const paystack = countingPaystack('pay_offline');
    const result = await service(paystack).chargeMobileMoney(
      { scheduleId, email: 'adwoa@x.gh', phone: '+233244000111', provider: 'mtn' },
      ACTOR,
    );
    // The colon-joined key stays internal — it is what UNIQUE() de-duplicates on.
    expect(result.attempt.idempotency_key).toBe(`${scheduleId}:1`);
  });

  it('cannot activate one application into two plans', async () => {
    const applicationId = await approvedApplication();
    const { plan } = await plans.activateFromApplication(applicationId, ACTOR);
    expect(plan.id).toBeTruthy();

    await expect(plans.activateFromApplication(applicationId, ACTOR)).rejects.toBeInstanceOf(
      PlanAlreadyActiveError,
    );
  });

  it('concurrent activation of one application creates exactly one plan', async () => {
    const applicationId = await approvedApplication();

    const results = await Promise.allSettled([
      plans.activateFromApplication(applicationId, ACTOR),
      plans.activateFromApplication(applicationId, ACTOR),
    ]);

    // Without customer_plans_application_uq both inserts succeed under READ
    // COMMITTED, double-scheduling the customer and double-paying the merchant.
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });
});
