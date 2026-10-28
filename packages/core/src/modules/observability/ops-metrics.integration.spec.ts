import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { createTestDb, schema } from '@installment/db';
import { AuditLogger } from '../audit/audit-logger.service';
import { SYSTEM_ACTORS } from '../../shared/constants/system-actors';
import { LedgerService } from '../../shared/ledger/ledger.service';
import { MerchantsService } from '../merchants/merchants.service';
import { CustomersService } from '../customers/customers.service';
import { MockGhanaCardVerifier } from '../customers/ghana-card-verifier';
import { PlanTemplatesService } from '../plans/plan-templates.service';
import { ApplicationsService } from '../applications/applications.service';
import { CustomerPlansService } from '../schedules/customer-plans.service';
import { OpsMetricsService, type OpsSnapshot } from './ops-metrics.service';

const RUN_DB = Boolean(process.env.DATABASE_URL);
const sched = schema.installment_schedule;

/**
 * The backlog the metrics endpoint publishes, read from real rows. Each figure
 * is checked as a change between two snapshots, since other files share the
 * worker database.
 */
describe.skipIf(!RUN_DB)('OpsMetricsService (integration)', () => {
  const { db, pool } = createTestDb();
  const audit = new AuditLogger();
  const ledger = new LedgerService(db);
  const merchants = new MerchantsService(db, audit);
  const customers = new CustomersService(db, audit, new MockGhanaCardVerifier());
  const templates = new PlanTemplatesService(db, audit);
  const apps = new ApplicationsService(db, audit);
  const plans = new CustomerPlansService(db, audit);
  const ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };
  const refunds = { summary: async () => [] };
  const ops = new OpsMetricsService(db, refunds as never);
  const payoutIds: string[] = [];

  let merchantId: string;
  let planId: string;
  let scheduleIds: string[];

  beforeAll(async () => {
    const suffix = randomUUID();
    merchantId = (
      await merchants.create(
        {
          business_name: `Ops ${suffix}`,
          legal_name: `Ops Ltd ${suffix}`,
          email: `ops+${suffix}@x.gh`,
          phone: `+2332${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
        },
        ACTOR,
      )
    ).id;
    const customerId = (
      await customers.register(
        {
          first_name: 'Akua',
          last_name: 'Owusu',
          email: `akua+${suffix}@x.gh`,
          phone: `024${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
        },
        ACTOR,
      )
    ).id;
    const templateId = (
      await templates.create(
        {
          name: `BNPL ops ${suffix}`,
          business_model: 'bnpl',
          number_of_installments: 4,
          installment_frequency_days: 7,
          min_amount_pesewas: 1_000,
          max_amount_pesewas: 10_000_000,
        },
        ACTOR,
      )
    ).id;
    const app = await apps.submit(
      {
        customer_id: customerId,
        merchant_id: merchantId,
        plan_template_id: templateId,
        order_reference: `ORD-${suffix}`,
        order_amount_pesewas: 400_000,
        merchant_category: 'electronics',
      },
      ACTOR,
    );
    await apps.recordDecision(app.id, { outcome: 'approved' }, ACTOR);
    const activated = await plans.activateFromApplication(app.id, ACTOR);
    planId = activated.plan.id;
    scheduleIds = activated.schedule.map((s) => s.id);
  });

  afterAll(async () => {
    if (payoutIds.length)
      await db.delete(schema.payouts).where(inArray(schema.payouts.id, payoutIds));
    await pool.end();
  });

  const delta = (before: OpsSnapshot, after: OpsSnapshot) => ({
    processing: after.schedules.processing - before.schedules.processing,
    overdue: after.schedules.overdue - before.schedules.overdue,
    stuck: after.stuckProcessing - before.stuckProcessing,
    unknownPayouts: after.payoutsInFlight.unknown - before.payoutsInFlight.unknown,
    pendingPayouts:
      after.payoutsInFlight.pending_confirmation - before.payoutsInFlight.pending_confirmation,
    softReminders:
      (after.collectionsOpen.soft_reminder ?? 0) - (before.collectionsOpen.soft_reminder ?? 0),
    sellersOwing: after.sellersOwing.count - before.sellersOwing.count,
    owedPesewas: after.sellersOwing.pesewas - before.sellersOwing.pesewas,
  });

  it('counts instalments by status, and only the old ones in processing as stuck', async () => {
    const before = await ops.snapshot();
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    await db
      .update(sched)
      .set({ status: 'processing', status_changed_at: twoHoursAgo })
      .where(eq(sched.id, scheduleIds[1]!));
    await db
      .update(sched)
      .set({ status: 'processing', status_changed_at: new Date().toISOString() })
      .where(eq(sched.id, scheduleIds[2]!));
    await db.update(sched).set({ status: 'overdue' }).where(eq(sched.id, scheduleIds[3]!));

    const d = delta(before, await ops.snapshot());
    expect(d.processing).toBe(2);
    expect(d.stuck).toBe(1); // the one changed two hours ago, not the one just now
    expect(d.overdue).toBe(1);
  });

  it('counts payouts with no answer, and how the latest settlement day ended', async () => {
    const before = await ops.snapshot();
    const today = new Date().toISOString().slice(0, 10);
    const rows = await db
      .insert(schema.payouts)
      .values([
        {
          merchant_id: merchantId,
          amount_pesewas: 1_000,
          as_of_date: today,
          reference: `p-${randomUUID()}`,
          status: 'unknown',
        },
        {
          merchant_id: merchantId,
          amount_pesewas: 1_000,
          as_of_date: '2099-01-02',
          reference: `p-${randomUUID()}`,
          status: 'pending_confirmation',
        },
      ])
      .returning({ id: schema.payouts.id });
    payoutIds.push(...rows.map((r) => r.id));

    const after = await ops.snapshot();
    expect(delta(before, after)).toMatchObject({ unknownPayouts: 1, pendingPayouts: 1 });
    expect(after.latestPayoutDay).toEqual({
      asOfDate: '2099-01-02',
      byStatus: { pending_confirmation: 1 },
    });
  });

  it('counts open collections cases by stage, and not closed ones', async () => {
    const before = await ops.snapshot();
    await db.insert(schema.collections_cases).values([
      { customer_plan_id: planId, schedule_id: scheduleIds[3]!, current_stage: 'soft_reminder' },
      {
        customer_plan_id: planId,
        current_stage: 'soft_reminder',
        closed_at: new Date().toISOString(),
        resolution: 'paid',
      },
    ]);
    expect(delta(before, await ops.snapshot()).softReminders).toBe(1);
  });

  it('counts a seller as owing only when their payable balance is below zero', async () => {
    const before = await ops.snapshot();
    const owing = randomUUID();
    const owed = randomUUID();
    const post = (ref: string, direction: 'debit' | 'credit', amount: number) => {
      const transactionId = `ops-test:${randomUUID()}`;
      return ledger.record([
        {
          transactionId,
          accountType: 'merchant_payable',
          accountRef: ref,
          direction,
          amountPesewas: amount,
          description: 'ops metrics test',
        },
        {
          transactionId,
          accountType: 'paystack_settlement',
          accountRef: 'main',
          direction: direction === 'debit' ? 'credit' : 'debit',
          amountPesewas: amount,
          description: 'ops metrics test',
        },
      ]);
    };
    await post(owing, 'credit', 5_000);
    await post(owing, 'debit', 8_000); // a return took back more than was left
    await post(owed, 'credit', 3_000); // owed money, not owing it

    expect(delta(before, await ops.snapshot())).toMatchObject({
      sellersOwing: 1,
      owedPesewas: 3_000,
    });
  });
});
