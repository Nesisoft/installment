import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, schema } from '@installment/db';
import { eq } from 'drizzle-orm';
import { AuditLogger } from '../audit/audit-logger.service';
import { SYSTEM_ACTORS } from '../../shared/constants/system-actors';
import { approveGhanaCard } from '../../shared/test-fixtures/ghana-card';
import { CustomersService } from '../customers/customers.service';
import { MockGhanaCardVerifier } from '../customers/ghana-card-verifier';
import { PlanTemplatesService } from '../plans/plan-templates.service';
import { FeatureCollector } from './feature-collector';
import { ScoringEngine } from './scoring-engine';
import type { FeatureVector } from './types';

const RUN_DB = Boolean(process.env.DATABASE_URL);

/**
 * The starter policy, run against features the real collectors produce.
 *
 * The unit specs build their own `FeatureVector` and so can assert anything.
 * This one cannot: it reads a customer out of Postgres through
 * `FeatureCollector`, which is where the policy nearly died. The first draft
 * required `identity.phoneVerified` — a field `IdentityCollector` returns as a
 * hard-coded `false` because nothing captures it on `customers` yet. Every unit
 * test passed and the policy could not have fired for a single real customer.
 *
 * A rule that can never fire is worse than no rule; it reads as protection.
 * This spec is the thing that would have said so.
 */
describe.skipIf(!RUN_DB)('thin-file starter limit (integration)', () => {
  const { db, pool } = createTestDb();
  const audit = new AuditLogger();
  const customers = new CustomersService(db, audit, new MockGhanaCardVerifier());
  const templates = new PlanTemplatesService(db, audit);
  const collector = FeatureCollector.fromDb(db);
  const engine = new ScoringEngine();
  const ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  /** "Pay in 4": 40% up front, so a GHS 400 order lends GHS 240. */
  let payInFour: string;

  beforeAll(async () => {
    payInFour = (
      await templates.create(
        {
          name: `Pay in 4 ${randomUUID().slice(0, 8)}`,
          business_model: 'bnpl',
          number_of_installments: 3,
          down_payment_bps: 4_000,
          installment_frequency_days: 7,
          min_amount_pesewas: 1_000,
          max_amount_pesewas: 5_000_000,
        },
        ACTOR,
      )
    ).id;
  });

  afterAll(async () => {
    await pool.end();
  });

  /**
   * Somebody who walked into KYC, verified their card, and has never borrowed.
   * The phone is aged past `gate.phone_age` because that gate is about a SIM
   * bought this morning, and this policy is about a first loan, not a first day.
   */
  async function verifiedNewCustomer(phoneAgeDays = 60): Promise<string> {
    const suffix = randomUUID();
    const customer = await customers.register(
      {
        first_name: 'Ama',
        last_name: 'Mensah',
        email: `starter+${suffix}@fixture.local`,
        phone: `024${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
        date_of_birth: '1995-06-15',
        consents: { data_processing: true, credit_scoring: true },
      },
      ACTOR,
    );
    const firstSeen = new Date(Date.now() - phoneAgeDays * 86_400_000).toISOString();
    await db
      .update(schema.customers)
      .set({ phone_first_seen_at: firstSeen })
      .where(eq(schema.customers.id, customer.id));
    // Through the real service, which grants tier 1. This fixture used to write
    // `kyc_tier: 2` by hand — a state nothing in the product can produce, so
    // the 100-point band of `score.kyc_tier` was being asserted into existence
    // here. The assertions below still hold at tier 1, and now hold against a
    // customer who could actually exist.
    await approveGhanaCard(db, customer.id);
    return customer.id;
  }

  async function decide(customerId: string, orderAmountGhs: number) {
    const request: FeatureVector['request'] = {
      orderAmountGhs,
      merchantCategory: 'electronics',
      planTemplateId: payInFour,
      planMinGhs: 10,
      planMaxGhs: 50_000,
      downPaymentBps: 4_000,
    };
    return engine.score(await collector.collect(customerId, request));
  }

  it('approves a real, verified, first-time customer', async () => {
    const decision = await decide(await verifiedNewCustomer(), 400);

    expect(decision.outcome).toBe('approved');
    expect(decision.approvedLimitGhs).toBe(400);
  });

  it('is the policy doing it, not a high score', async () => {
    const decision = await decide(await verifiedNewCustomer(), 400);

    // The score stays low and the band stays honest — an analyst reading this
    // decision has to be able to see it was a deliberate appetite, not a
    // creditworthy applicant.
    expect(decision.riskBand).toBe('unscorable');
    expect(decision.score).toBeLessThan(350);
  });

  it('still declines the same customer for an order over the cap', async () => {
    // GHS 1000 at 40% down lends GHS 600, well past the GHS 250 ceiling.
    const decision = await decide(await verifiedNewCustomer(), 1_000);

    expect(decision.outcome).toBe('declined');
  });

  it('still declines a customer whose Ghana Card is not verified', async () => {
    const suffix = randomUUID();
    const customer = await customers.register(
      {
        first_name: 'Kofi',
        last_name: 'Owusu',
        email: `unverified+${suffix}@fixture.local`,
        phone: `024${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
        date_of_birth: '1995-06-15',
        consents: { data_processing: true, credit_scoring: true },
      },
      ACTOR,
    );

    expect((await decide(customer.id, 400)).outcome).toBe('declined');
  });

  /**
   * `phone_first_seen_at` defaults to now(), so a customer who signed up this
   * morning fails `gate.phone_age` whatever their card says. Worth pinning: it
   * means "first order" is not "first day", and the thirty days is tunable from
   * `rule_definitions` without a deploy if that turns out to be too patient.
   */
  it('declines a signup from today, because the phone-age gate comes first', async () => {
    const decision = await decide(await verifiedNewCustomer(0), 400);

    expect(decision.outcome).toBe('declined');
    expect(decision.rulesFired.find((r) => r.ruleId === 'gate.phone_age')?.passed).toBe(false);
  });
});
