import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, schema } from '@installment/db';
import { AuditLogger } from '../audit/audit-logger.service';
import { SYSTEM_ACTORS } from '../../shared/constants/system-actors';
import { MerchantsService } from '../merchants/merchants.service';
import { CustomersService } from '../customers/customers.service';
import { MockGhanaCardVerifier } from '../customers/ghana-card-verifier';
import { PlanTemplatesService } from '../plans/plan-templates.service';
import { ApplicationsService } from '../applications/applications.service';
import { CustomerPlansService } from '../schedules/customer-plans.service';
import { CollectionsService, type PlanDefaulter } from './collections.service';

const RUN_DB = Boolean(process.env.DATABASE_URL);

/**
 * What happens to a collections case when the customer actually pays.
 *
 * Four events leave `in_collections` in the state machine. Two are dispatched
 * by live code (`payment_recovered`, `default_threshold_hit`); two are
 * dispatched by nothing (`admin_waive`, `restructure_approved`).
 *
 * The gap that costs money is narrower than that and worse. Paying moves the
 * SCHEDULE to `paid`, and nothing anywhere closes the CASE — `closed_at` is
 * written in exactly two places, the write-off path and the manual
 * `closeCase`, neither of which a payment reaches. So the case stays open,
 * `advanceStages` keeps escalating it by age (it filters on `closed_at` alone
 * and never looks at the instalment), the customer keeps receiving dunning
 * SMS after they have paid, and on day 90 `resolveWriteOff` calls
 * `markPlanDefaulted` BEFORE it checks whether the debt still stands.
 *
 * That last call is not bookkeeping: defaulting a plan writes off the
 * receivable, consumes the merchant's reserve and claws back the remainder.
 * A customer who paid gets three months of dunning and then a default.
 */
describe.skipIf(!RUN_DB)('collections after payment (integration)', () => {
  const { db, pool } = createTestDb();
  const audit = new AuditLogger();
  const merchants = new MerchantsService(db, audit);
  const customers = new CustomersService(db, audit, new MockGhanaCardVerifier());
  const planTemplates = new PlanTemplatesService(db, audit);
  const apps = new ApplicationsService(db, audit);
  const plans = new CustomerPlansService(db, audit);
  const ACTOR = { actorId: SYSTEM_ACTORS.COLLECTIONS_BOT, actorType: 'system' as const };

  /** Records which plans were asked to default, without booking anything. */
  function recordingDefaulter(): PlanDefaulter & { defaulted: string[] } {
    const defaulted: string[] = [];
    return {
      defaulted,
      async markPlanDefaulted(planId: string) {
        defaulted.push(planId);
        return undefined;
      },
    };
  }

  let bnplTemplateId: string;

  beforeAll(async () => {
    const suffix = randomUUID();
    bnplTemplateId = (
      await planTemplates.create(
        {
          name: `BNPL-colpay ${suffix}`,
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

  async function activatedSchedule() {
    const suffix = randomUUID();
    const merchant = await merchants.create(
      {
        business_name: `MC ${suffix}`,
        legal_name: `MC ${suffix}`,
        email: `mc+${suffix}@x.gh`,
        phone: '+233244000000',
      },
      ACTOR,
    );
    const customer = await customers.register(
      {
        first_name: 'Paid',
        last_name: 'Up',
        email: `pu+${suffix}@x.gh`,
        phone: `024${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
      },
      ACTOR,
    );
    const app = await apps.submit(
      {
        customer_id: customer.id,
        merchant_id: merchant.id,
        plan_template_id: bnplTemplateId,
        order_reference: `ORD-${randomUUID()}`,
        order_amount_pesewas: 100_000,
        merchant_category: 'electronics',
      },
      ACTOR,
    );
    await apps.recordDecision(app.id, { outcome: 'approved' }, ACTOR);
    return plans.activateFromApplication(app.id, ACTOR);
  }

  /** Drives one instalment all the way into an open collections case. */
  async function caseInCollections(collections: CollectionsService) {
    const { plan, schedule } = await activatedSchedule();
    const row = schedule[0]!;
    await db
      .update(schema.installment_schedule)
      .set({ status: 'failed', due_date: '2000-01-01', grace_until_date: '2000-01-02' })
      .where(eq(schema.installment_schedule.id, row.id));
    await collections.escalateGraceExpired(new Date(), ACTOR, { limit: 5_000 });
    await collections.openCasesForOverdue(ACTOR, new Date());
    const [c] = await db
      .select()
      .from(schema.collections_cases)
      .where(eq(schema.collections_cases.schedule_id, row.id));
    expect(c).toBeDefined();
    return { planId: plan.id, scheduleId: row.id, caseId: c!.id };
  }

  /** Makes the case look 90+ days old, so it is due for write-off. */
  async function ageCase(caseId: string) {
    await db
      .update(schema.collections_cases)
      .set({ opened_at: '2024-01-01T00:00:00Z' })
      .where(eq(schema.collections_cases.id, caseId));
  }

  it('closes the case when the instalment is paid', async () => {
    const collections = new CollectionsService(db, audit);
    const { scheduleId, caseId } = await caseInCollections(collections);

    await plans.recordManualPayment(scheduleId, {}, ACTOR);
    const [paid] = await db
      .select()
      .from(schema.installment_schedule)
      .where(eq(schema.installment_schedule.id, scheduleId));
    expect(paid!.status).toBe('paid');

    await collections.runSweep(ACTOR, new Date());

    const [c] = await db
      .select()
      .from(schema.collections_cases)
      .where(eq(schema.collections_cases.id, caseId));
    expect(c!.closed_at).not.toBeNull();
    expect(c!.resolution).toBe('paid');
  });

  it('stops escalating a case whose instalment is paid', async () => {
    const collections = new CollectionsService(db, audit);
    const { scheduleId, caseId } = await caseInCollections(collections);
    await plans.recordManualPayment(scheduleId, {}, ACTOR);
    await ageCase(caseId);

    await collections.runSweep(ACTOR, new Date());

    const [c] = await db
      .select()
      .from(schema.collections_cases)
      .where(eq(schema.collections_cases.id, caseId));
    // A paid case must never reach write_off — that is the stage that defaults
    // the plan.
    expect(c!.current_stage).not.toBe('write_off');
    expect(c!.closed_at).not.toBeNull();
  });

  it('never defaults the plan of a customer who has paid', async () => {
    const defaulter = recordingDefaulter();
    const collections = new CollectionsService(db, audit, defaulter);
    const { planId, scheduleId, caseId } = await caseInCollections(collections);

    await plans.recordManualPayment(scheduleId, {}, ACTOR);
    await ageCase(caseId);
    // Force the case to the terminal stage directly, so this holds even if a
    // case reaches write_off by some route the sweep does not police.
    await db
      .update(schema.collections_cases)
      .set({ current_stage: 'write_off' })
      .where(eq(schema.collections_cases.id, caseId));

    await collections.defaultWrittenOffCases(ACTOR, new Date());

    // Defaulting writes off the receivable, consumes the merchant's reserve
    // and claws back the rest. None of that may happen for a settled debt.
    expect(defaulter.defaulted).not.toContain(planId);

    const [s] = await db
      .select()
      .from(schema.installment_schedule)
      .where(eq(schema.installment_schedule.id, scheduleId));
    expect(s!.status).toBe('paid');
  });

  it('waiving a case actually ends the debt rather than stranding it', async () => {
    const collections = new CollectionsService(db, audit);
    const { scheduleId, caseId } = await caseInCollections(collections);

    await collections.closeCase(caseId, { resolution: 'waived' }, ACTOR);

    // Without the transition the row sat at `in_collections` with its case
    // closed: `openCasesForOverdue` only selects `overdue`, so nothing would
    // ever look at it again.
    const [s] = await db
      .select()
      .from(schema.installment_schedule)
      .where(eq(schema.installment_schedule.id, scheduleId));
    expect(s!.status).toBe('waived');

    const [c] = await db
      .select()
      .from(schema.collections_cases)
      .where(eq(schema.collections_cases.id, caseId));
    expect(c!.resolution).toBe('waived');
    expect(c!.closed_at).not.toBeNull();
  });

  it('still defaults a plan whose instalment is genuinely unpaid', async () => {
    const defaulter = recordingDefaulter();
    const collections = new CollectionsService(db, audit, defaulter);
    const { planId, scheduleId, caseId } = await caseInCollections(collections);
    await ageCase(caseId);
    await db
      .update(schema.collections_cases)
      .set({ current_stage: 'write_off' })
      .where(eq(schema.collections_cases.id, caseId));

    await collections.defaultWrittenOffCases(ACTOR, new Date());

    expect(defaulter.defaulted).toContain(planId);
    const [s] = await db
      .select()
      .from(schema.installment_schedule)
      .where(eq(schema.installment_schedule.id, scheduleId));
    expect(s!.status).toBe('defaulted');
  });
});
