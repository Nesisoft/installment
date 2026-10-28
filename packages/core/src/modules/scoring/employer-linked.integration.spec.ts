import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, schema } from '@installment/db';
import { eq } from 'drizzle-orm';
import { AuditLogger } from '../audit/audit-logger.service';
import { SYSTEM_ACTORS } from '../../shared/constants/system-actors';
import { approveGhanaCard } from '../../shared/test-fixtures/ghana-card';
import { CustomersService } from '../customers/customers.service';
import { MockGhanaCardVerifier } from '../customers/ghana-card-verifier';
import { EmployersService } from '../employers/employers.service';
import { CustomerEmploymentService } from '../employers/customer-employment.service';
import { PlanTemplatesService } from '../plans/plan-templates.service';
import { FeatureCollector } from './feature-collector';
import { ScoringEngine } from './scoring-engine';
import type { FeatureVector } from './types';

const RUN_DB = Boolean(process.env.DATABASE_URL);

/**
 * The employment tiers, run against features the real collectors produce.
 *
 * The unit spec builds its own `FeatureVector` and can therefore assert
 * anything, including that a field is true which no collector ever sets. That
 * is how the first draft of the thin-file policy nearly shipped requiring
 * `identity.phoneVerified` — a hard-coded `false` — with every unit test green
 * and the policy unable to fire for a single real customer.
 *
 * So this spec drives the whole path through Postgres: an employer that has to
 * be activated, an employment link that has to be created, verified and
 * consented to, and a decision taken from what `FeatureCollector` reads back.
 * If `employerVerified` were unreachable, this is the file that would say so.
 */
describe.skipIf(!RUN_DB)('employer-linked first-timers (integration)', () => {
  const { db, pool } = createTestDb();
  const audit = new AuditLogger();
  const customers = new CustomersService(db, audit, new MockGhanaCardVerifier());
  const employers = new EmployersService(db, audit);
  const employment = new CustomerEmploymentService(db, audit);
  const templates = new PlanTemplatesService(db, audit);
  const collector = FeatureCollector.fromDb(db);
  const engine = new ScoringEngine();
  const ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  /** Zero deposit, so the order amount IS the financed amount. */
  let payInFull: string;

  beforeAll(async () => {
    payInFull = (
      await templates.create(
        {
          name: `Weekly 4 ${randomUUID().slice(0, 8)}`,
          business_model: 'bnpl',
          number_of_installments: 4,
          down_payment_bps: 0,
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

  async function verifiedNewCustomer(): Promise<string> {
    const suffix = randomUUID();
    const customer = await customers.register(
      {
        first_name: 'Yaw',
        last_name: 'Asante',
        email: `employed+${suffix}@fixture.local`,
        phone: `024${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
        date_of_birth: '1994-03-02',
        consents: { data_processing: true, credit_scoring: true },
      },
      ACTOR,
    );
    // Aged past `gate.phone_age`: that gate is about a SIM bought this morning.
    const firstSeen = new Date(Date.now() - 90 * 86_400_000).toISOString();
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

  async function activeEmployer(): Promise<string> {
    const created = await employers.create(
      { name: `Ghana Water ${randomUUID().slice(0, 8)}`, sector: 'public' },
      ACTOR,
    );
    // Employers are created `pending`; only an activated partnership counts.
    const active = await employers.transition(created.id, { event: 'activate' }, ACTOR);
    expect(active.status).toBe('active');
    return created.id;
  }

  interface LinkOptions {
    consent?: boolean;
    verify?: boolean;
    employerEvent?: 'pause' | 'terminate';
  }

  async function employ(
    customerId: string,
    employerId: string,
    opts: LinkOptions = {},
  ): Promise<void> {
    const link = await employment.link(
      {
        customer_id: customerId,
        employer_id: employerId,
        employee_number: `E${Math.floor(100_000 + Math.random() * 899_999)}`,
        salary_band: 'mid',
        employment_start_date: '2020-01-15',
        payroll_deduction_consent: opts.consent ?? false,
      },
      ACTOR,
    );
    // `customer_employment.status` defaults to 'active' on insert — the link is
    // live the moment it is saved, which is exactly why the engine wants
    // `verified_at` and not the bare link.
    expect(link.status).toBe('active');
    if (opts.verify) {
      await employment.markVerified(
        link.id,
        { method: 'employer_confirmed', note: 'HR confirmed by phone' },
        ACTOR,
      );
    }
    if (opts.employerEvent) {
      await employers.transition(employerId, { event: opts.employerEvent }, ACTOR);
    }
  }

  async function featuresFor(customerId: string, orderAmountGhs: number) {
    const request: FeatureVector['request'] = {
      orderAmountGhs,
      merchantCategory: 'electronics',
      planTemplateId: payInFull,
      planMinGhs: 10,
      planMaxGhs: 50_000,
      downPaymentBps: 0,
    };
    return collector.collect(customerId, request);
  }

  async function decide(customerId: string, orderAmountGhs: number) {
    return engine.score(await featuresFor(customerId, orderAmountGhs));
  }

  // ---------------------------------------------------------- reachability

  it('collects employerVerified as true for a verified link — the field is reachable', async () => {
    const customerId = await verifiedNewCustomer();
    await employ(customerId, await activeEmployer(), { verify: true, consent: true });

    const f = await featuresFor(customerId, 400);

    expect(f.employment.employerLinked).toBe(true);
    expect(f.employment.employerVerified).toBe(true);
    expect(f.employment.payrollDeductionConsent).toBe(true);
    expect(f.employment.salaryBand).toBe('mid');
  });

  it('collects it as false for a link nobody verified', async () => {
    const customerId = await verifiedNewCustomer();
    await employ(customerId, await activeEmployer(), { verify: false });

    const f = await featuresFor(customerId, 400);

    expect(f.employment.employerLinked).toBe(true);
    expect(f.employment.employerVerified).toBe(false);
  });

  // ------------------------------------------------- the employer must be live

  it('ignores a link to a terminated employer', async () => {
    const customerId = await verifiedNewCustomer();
    await employ(customerId, await activeEmployer(), {
      verify: true,
      consent: true,
      employerEvent: 'terminate',
    });

    // The employment row is still `active` — nobody goes back to close it when
    // a partnership ends — so reading only that table scored a wound-up payroll
    // relationship exactly like a live one.
    const f = await featuresFor(customerId, 400);

    expect(f.employment.employerLinked).toBe(false);
    expect(f.employment.employerVerified).toBe(false);
    expect(f.employment.payrollDeductionConsent).toBe(false);
  });

  it('ignores a link to a paused employer', async () => {
    const customerId = await verifiedNewCustomer();
    await employ(customerId, await activeEmployer(), {
      verify: true,
      consent: true,
      employerEvent: 'pause',
    });

    expect((await featuresFor(customerId, 400)).employment.employerLinked).toBe(false);
  });

  it('drops the linkage points along with the link', async () => {
    const live = await verifiedNewCustomer();
    await employ(live, await activeEmployer(), { verify: true, consent: true });
    const dead = await verifiedNewCustomer();
    await employ(dead, await activeEmployer(), {
      verify: true,
      consent: true,
      employerEvent: 'terminate',
    });

    const pointsFor = async (id: string) =>
      (await decide(id, 200)).rulesFired.find((r) => r.ruleId === 'score.employer_linked')?.points;

    expect(await pointsFor(live)).toBeGreaterThan(0);
    expect(await pointsFor(dead)).toBe(0);
  });

  // ------------------------------------------------------------- the decision

  it('approves the order that used to go to a human', async () => {
    const customerId = await verifiedNewCustomer();
    await employ(customerId, await activeEmployer(), { verify: true });

    // GHS 600 financed: past the base GHS 250, inside the employer GHS 750.
    const decision = await decide(customerId, 600);

    expect(decision.outcome).toBe('approved');
    expect(decision.approvedLimitGhs).toBe(600);
  });

  it('reaches the payroll ceiling with consent', async () => {
    const customerId = await verifiedNewCustomer();
    await employ(customerId, await activeEmployer(), { verify: true, consent: true });

    expect((await decide(customerId, 2_000)).outcome).toBe('approved');
    expect((await decide(customerId, 2_001)).outcome).not.toBe('approved');
  });

  it('holds an unverified link to the base ceiling', async () => {
    const customerId = await verifiedNewCustomer();
    await employ(customerId, await activeEmployer(), { verify: false, consent: true });

    // Consent against a link nobody checked buys nothing: still GHS 250.
    expect((await decide(customerId, 250)).outcome).toBe('approved');
    expect((await decide(customerId, 600)).outcome).not.toBe('approved');
  });

  it('holds an unemployed newcomer to the base ceiling', async () => {
    const customerId = await verifiedNewCustomer();

    expect((await decide(customerId, 250)).outcome).toBe('approved');
    expect((await decide(customerId, 600)).outcome).not.toBe('approved');
  });

  /**
   * The two scores this change sits between, from real rows: 175 unemployed and
   * 325 with a live employer link.
   *
   * These were 225 and 375 until the fixture stopped writing `kyc_tier: 2` by
   * hand. Nothing in this system raises the tier past 1 — `verifyGhanaCard`
   * caps it there and no other writer exists — so the 100-point band of
   * `score.kyc_tier` was being asserted into existence by the fixture, and
   * every number here was 50 too high. PLATFORM-ROADMAP.md's own arithmetic
   * makes the same mistake, counting "KYC tier 2 100" toward a first-timer
   * ceiling of 325; the real ceiling is 275.
   *
   * The consequence is the interesting part: **a verified, employed first-timer
   * does not reach `subprime` at all.** 325 is under the 350 floor, so both of
   * these customers are `unscorable`, and every approval either of them gets is
   * the starter policy's doing rather than the score's. That was already true
   * of the unemployed one; it is now true of both.
   *
   * The unit spec's 275/425 are higher again because its fixture grants a known
   * device and address proof that nothing populates on a real customer yet.
   */
  it('separates the two first-timers by exactly the rule under test', async () => {
    const unemployed = await verifiedNewCustomer();
    const employed = await verifiedNewCustomer();
    await employ(employed, await activeEmployer(), { verify: true, consent: true });

    const a = await decide(unemployed, 600);
    const b = await decide(employed, 600);

    expect(a.score).toBe(175);
    expect(b.score).toBe(325);
    // The 150-point difference is one rule, and it is the one under test.
    expect(b.rulesFired.find((r) => r.ruleId === 'score.employer_linked')?.points).toBe(150);
  });

  it('leaves even the employed first-timer short of the subprime floor', async () => {
    // Worth its own test because it is a policy fact, not an implementation
    // detail: 325 < 350, so nothing a first-time customer can do — verify their
    // card, hold down a verified job — scores them into a band. Approval for
    // them is the starter ceiling or nothing, and that is the decision waiting
    // on an owner.
    const employed = await verifiedNewCustomer();
    await employ(employed, await activeEmployer(), { verify: true, consent: true });

    const decision = await decide(employed, 600);

    expect(decision.score).toBeLessThan(350);
    expect(decision.riskBand).toBe('unscorable');
  });

  it('is the policy deciding, not a creditworthy applicant', async () => {
    const customerId = await verifiedNewCustomer();
    await employ(customerId, await activeEmployer(), { verify: true, consent: true });

    const decision = await decide(customerId, 1_500);

    // The band and score stay honest: somebody reading this decision has to be
    // able to see a deliberate appetite rather than a strong file. `unscorable`
    // rather than `subprime` since the fixture stopped claiming tier 2 — which
    // makes the point more sharply, not less: this approval comes entirely from
    // the payroll ceiling.
    expect(decision.outcome).toBe('approved');
    expect(decision.riskBand).toBe('unscorable');
    expect(decision.score).toBeLessThan(350);
  });

  it('still refuses a customer whose Ghana Card is not verified', async () => {
    const suffix = randomUUID();
    const customer = await customers.register(
      {
        first_name: 'Adjoa',
        last_name: 'Nkrumah',
        email: `nocard+${suffix}@fixture.local`,
        phone: `024${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
        date_of_birth: '1994-03-02',
        consents: { data_processing: true, credit_scoring: true },
      },
      ACTOR,
    );
    await employ(customer.id, await activeEmployer(), { verify: true, consent: true });

    expect((await decide(customer.id, 600)).outcome).not.toBe('approved');
  });
});
