import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import { createDb, schema } from '@installment/db';
import { AuditLogger } from '../audit/audit-logger.service';
import { SYSTEM_ACTORS } from '../../shared/constants/system-actors';
import { MerchantsService } from '../merchants/merchants.service';
import { CustomersService } from '../customers/customers.service';
import { MockGhanaCardVerifier } from '../customers/ghana-card-verifier';
import { PlanTemplatesService } from '../plans/plan-templates.service';
import { ApplicationsService } from '../applications/applications.service';
import { IllegalApplicationTransitionError } from '../applications/state-machine';
import { ScoringEngine } from './scoring-engine';
import { FeatureCollector } from './feature-collector';
import { ScoringService } from './scoring.service';

const RUN_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!RUN_DB)('ScoringService (integration)', () => {
  const { db, pool } = createDb({ connectionString: process.env.DATABASE_URL! });
  const audit = new AuditLogger();
  const merchants = new MerchantsService(db, audit);
  const customers = new CustomersService(db, audit, new MockGhanaCardVerifier());
  const plans = new PlanTemplatesService(db, audit);
  const apps = new ApplicationsService(db, audit);
  const scoring = new ScoringService(db, FeatureCollector.fromDb(db), new ScoringEngine(), apps);
  const SYSTEM_ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

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

  async function newCustomerId(): Promise<string> {
    const c = await customers.register(
      {
        first_name: 'Ama',
        last_name: 'Mensah',
        email: `ama+${randomUUID()}@x.gh`,
        phone: `024${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
        consents: { data_processing: true, credit_scoring: true },
      },
      SYSTEM_ACTOR,
    );
    return c.id;
  }

  async function submit(customerId: string): Promise<string> {
    const app = await apps.submit(
      {
        customer_id: customerId,
        merchant_id: merchantId,
        plan_template_id: planTemplateId,
        order_reference: `ORD-${randomUUID()}`,
        order_amount_pesewas: 500_000,
        merchant_category: 'electronics',
      },
      SYSTEM_ACTOR,
    );
    return app.id;
  }

  async function profilesFor(applicationId: string) {
    return db
      .select()
      .from(schema.credit_profiles)
      .where(eq(schema.credit_profiles.application_id, applicationId))
      .orderBy(desc(schema.credit_profiles.decided_at));
  }

  async function lastAppEvent(applicationId: string): Promise<string | undefined> {
    const rows = await db
      .select({ event_type: schema.audit_events.event_type })
      .from(schema.audit_events)
      .where(eq(schema.audit_events.entity_id, applicationId))
      .orderBy(desc(schema.audit_events.occurred_at))
      .limit(1);
    return rows[0]?.event_type;
  }

  it('scores, persists an immutable credit profile, and transitions the application', async () => {
    const appId = await submit(await newCustomerId());

    const { decision, application, creditProfile } = await scoring.scoreApplication(
      appId,
      SYSTEM_ACTOR,
    );

    // A fresh customer fails the Ghana-Card gate → declined.
    expect(decision.outcome).toBe('declined');
    expect(decision.score).toBe(0);
    expect(decision.riskBand).toBe('unscorable');

    expect(application.status).toBe('declined');
    expect(application.decision_at).not.toBeNull();
    expect(application.declined_reason).toBe('Ghana Card not verified');

    expect(creditProfile.outcome).toBe('declined');
    expect(creditProfile.ruleset_version).toBe(decision.rulesetVersion);
    expect(creditProfile.approved_limit_pesewas).toBe(0);
    expect(Array.isArray(creditProfile.rules_fired)).toBe(true);
    expect((creditProfile.rules_fired as unknown[]).length).toBeGreaterThan(0);
    expect(creditProfile.features_snapshot).toBeTruthy();

    expect(await lastAppEvent(appId)).toBe('application.decline');
    expect(await profilesFor(appId)).toHaveLength(1);
  });

  it('dry-runs without persisting anything', async () => {
    const appId = await submit(await newCustomerId());

    const decision = await scoring.dryRun(appId);
    expect(decision.outcome).toBe('declined');

    expect(await profilesFor(appId)).toHaveLength(0);
    expect((await apps.get(appId)).status).toBe('pending');
  });

  it('rolls the whole attempt back when re-scoring a terminal application', async () => {
    const appId = await submit(await newCustomerId());
    await scoring.scoreApplication(appId, SYSTEM_ACTOR); // → declined (terminal)

    await expect(scoring.scoreApplication(appId, SYSTEM_ACTOR)).rejects.toBeInstanceOf(
      IllegalApplicationTransitionError,
    );

    // The second profile insert was rolled back with the failed transition.
    expect(await profilesFor(appId)).toHaveLength(1);
  });
});
