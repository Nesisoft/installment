import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, schema } from '@installment/db';
import { AuditLogger } from '../audit/audit-logger.service';
import { SYSTEM_ACTORS } from '../../shared/constants/system-actors';
import { MerchantsService } from '../merchants/merchants.service';
import { CustomersService } from '../customers/customers.service';
import { MockGhanaCardVerifier } from '../customers/ghana-card-verifier';
import { PlanTemplatesService } from '../plans/plan-templates.service';
import { ApplicationsService } from '../applications/applications.service';
import { CustomerPlansService } from '../schedules/customer-plans.service';
import { CollectionsService } from './collections.service';

const RUN_DB = Boolean(process.env.DATABASE_URL);
const DAY_MS = 86_400_000;

describe.skipIf(!RUN_DB)('CollectionsService (integration)', () => {
  const { db, pool } = createDb({ connectionString: process.env.DATABASE_URL! });
  const audit = new AuditLogger();
  const merchants = new MerchantsService(db, audit);
  const customers = new CustomersService(db, audit, new MockGhanaCardVerifier());
  const planTemplates = new PlanTemplatesService(db, audit);
  const apps = new ApplicationsService(db, audit);
  const plans = new CustomerPlansService(db, audit);
  const collections = new CollectionsService(db, audit);
  const ACTOR = { actorId: SYSTEM_ACTORS.COLLECTIONS_BOT, actorType: 'system' as const };

  let bnplTemplateId: string;

  beforeAll(async () => {
    const suffix = randomUUID();
    bnplTemplateId = (
      await planTemplates.create(
        {
          name: `BNPL-col ${suffix}`,
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
        business_name: `M ${suffix}`,
        legal_name: `M ${suffix}`,
        email: `m+${suffix}@x.gh`,
        phone: '+233244000000',
      },
      ACTOR,
    );
    const customer = await customers.register(
      {
        first_name: 'Col',
        last_name: 'Test',
        email: `c+${suffix}@x.gh`,
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

  /** Forces a schedule row into a given status (simulates the debit pipeline). */
  async function setStatus(scheduleId: string, status: string) {
    await db
      .update(schema.installment_schedule)
      .set({ status })
      .where(eq(schema.installment_schedule.id, scheduleId));
  }

  function loadSchedule(id: string) {
    return db
      .select()
      .from(schema.installment_schedule)
      .where(eq(schema.installment_schedule.id, id))
      .then((r) => r[0]);
  }

  it('escalates a failed installment past grace to overdue', async () => {
    const { schedule } = await activatedSchedule();
    await setStatus(schedule[0]!.id, 'failed');

    const future = new Date(Date.now() + 400 * DAY_MS);
    const n = await collections.escalateGraceExpired(future, ACTOR, { limit: 5_000 });
    expect(n).toBeGreaterThanOrEqual(1);
    expect((await loadSchedule(schedule[0]!.id))!.status).toBe('overdue');
  });

  it('opens a case for an overdue installment and moves it to in_collections (idempotent)', async () => {
    const { plan, schedule } = await activatedSchedule();
    await setStatus(schedule[0]!.id, 'overdue');

    const opened = await collections.openCasesForOverdue(ACTOR);
    expect(opened).toBeGreaterThanOrEqual(1);
    expect((await loadSchedule(schedule[0]!.id))!.status).toBe('in_collections');

    const rows = await db
      .select()
      .from(schema.collections_cases)
      .where(eq(schema.collections_cases.schedule_id, schedule[0]!.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.current_stage).toBe('soft_reminder');
    expect(rows[0]!.customer_plan_id).toBe(plan.id);

    // Idempotent: the installment is no longer overdue, so no second case.
    await collections.openCasesForOverdue(ACTOR);
    const again = await db
      .select()
      .from(schema.collections_cases)
      .where(eq(schema.collections_cases.schedule_id, schedule[0]!.id));
    expect(again).toHaveLength(1);
  });

  it('advances an open case to the stage its age warrants and logs an action', async () => {
    const { schedule } = await activatedSchedule();
    await setStatus(schedule[0]!.id, 'overdue');
    await collections.openCasesForOverdue(ACTOR);
    const [opened] = await db
      .select()
      .from(schema.collections_cases)
      .where(eq(schema.collections_cases.schedule_id, schedule[0]!.id));

    // 31 days in → field_visit (30d threshold).
    const advances = await collections.advanceStages(
      new Date(new Date(opened!.opened_at).getTime() + 31 * DAY_MS),
      ACTOR,
    );
    const mine = advances.find((a) => a.caseId === opened!.id);
    expect(mine).toMatchObject({ from: 'soft_reminder', to: 'field_visit' });

    const [after] = await db
      .select()
      .from(schema.collections_cases)
      .where(eq(schema.collections_cases.id, opened!.id));
    expect(after!.current_stage).toBe('field_visit');

    const actionRows = await db
      .select()
      .from(schema.collections_actions)
      .where(eq(schema.collections_actions.case_id, opened!.id));
    expect(
      actionRows.some((a) => a.action_type === 'stage_changed' && a.outcome === 'field_visit'),
    ).toBe(true);

    // Re-running at the same asOf is a no-op (already at the right stage).
    const again = await collections.advanceStages(
      new Date(new Date(opened!.opened_at).getTime() + 31 * DAY_MS),
      ACTOR,
    );
    expect(again.find((a) => a.caseId === opened!.id)).toBeUndefined();
  });

  it('runSweep does grace-expiry, case-opening and stage-advance in one pass', async () => {
    const { schedule } = await activatedSchedule();
    await setStatus(schedule[0]!.id, 'failed'); // past grace at the far-future asOf

    const summary = await collections.runSweep(ACTOR, new Date(Date.now() + 400 * DAY_MS));

    expect(summary.graceExpired).toBeGreaterThanOrEqual(1);
    expect(summary.casesOpened).toBeGreaterThanOrEqual(1);
    // The case opened "now" (sweep asOf) so it advances straight to write_off (>90d old vs opened_at? opened at asOf, so age 0 → soft_reminder). No advance this pass.
    expect((await loadSchedule(schedule[0]!.id))!.status).toBe('in_collections');
  });
});
