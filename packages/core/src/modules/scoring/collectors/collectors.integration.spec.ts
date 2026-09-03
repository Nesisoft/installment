import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '@installment/db';
import { AuditLogger } from '../../audit/audit-logger.service';
import { SYSTEM_ACTORS } from '../../../shared/constants/system-actors';
import { MerchantsService } from '../../merchants/merchants.service';
import { CustomersService } from '../../customers/customers.service';
import { MockGhanaCardVerifier } from '../../customers/ghana-card-verifier';
import { PlanTemplatesService } from '../../plans/plan-templates.service';
import { ApplicationsService } from '../../applications/applications.service';
import { EmployersService } from '../../employers/employers.service';
import { CustomerEmploymentService } from '../../employers/customer-employment.service';
import { FeatureCollector } from '../feature-collector';
import { IdentityCollector } from './identity.collector';
import { RepaymentCollector } from './repayment.collector';
import { BehaviorCollector } from './behavior.collector';
import { TenureCollector } from './tenure.collector';
import { EmploymentCollector } from './employment.collector';
import { ExposureCollector } from './exposure.collector';

const RUN_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!RUN_DB)('Scoring collectors (integration)', () => {
  const { db, pool } = createTestDb();
  const audit = new AuditLogger();
  const merchants = new MerchantsService(db, audit);
  const customers = new CustomersService(db, audit, new MockGhanaCardVerifier());
  const plans = new PlanTemplatesService(db, audit);
  const apps = new ApplicationsService(db, audit);
  const employers = new EmployersService(db, audit);
  const employment = new CustomerEmploymentService(db, audit);
  const SYSTEM_ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  let merchantId: string;
  let planTemplateId: string;
  let employerId: string;

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
    const employer = await employers.create(
      { name: `Acme ${suffix}`, sector: 'private' },
      SYSTEM_ACTOR,
    );
    // Employers are created `pending`, and EmploymentCollector requires the
    // employer's own partnership to be live before it will report a link. This
    // fixture used to leave Acme pending and still expect the payroll signals
    // — which is what the collector used to do.
    await employers.transition(employer.id, { event: 'activate' }, SYSTEM_ACTOR);
    employerId = employer.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  function registerInput(dob?: string) {
    const suffix = randomUUID();
    return {
      first_name: 'Ama',
      last_name: 'Mensah',
      email: `ama+${suffix}@x.gh`,
      phone: `024${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
      date_of_birth: dob,
      consents: { data_processing: true, credit_scoring: true },
    };
  }

  async function newCustomerId(dob?: string): Promise<string> {
    const c = await customers.register(registerInput(dob), SYSTEM_ACTOR);
    return c.id;
  }

  function submitInput(customerId: string) {
    return {
      customer_id: customerId,
      merchant_id: merchantId,
      plan_template_id: planTemplateId,
      order_reference: `ORD-${randomUUID()}`,
      order_amount_pesewas: 500_000,
      merchant_category: 'electronics',
    };
  }

  describe('IdentityCollector', () => {
    it('reads verification, tier and derives age from a fresh customer', async () => {
      const id = await newCustomerId('1990-06-15');
      const sig = await new IdentityCollector(db).collect(id);
      expect(sig.ghanaCardVerified).toBe(false);
      expect(sig.kycTier).toBe(0);
      expect(typeof sig.ageYears).toBe('number');
      expect(sig.ageYears!).toBeGreaterThanOrEqual(18);
      expect(sig.phoneAgeDays).toBeGreaterThanOrEqual(0);
    });

    it('reflects a verified Ghana Card (tier bumped to 1)', async () => {
      const id = await newCustomerId('1990-06-15');
      const card = `GHA-${Math.floor(100_000_000 + Math.random() * 899_999_999)}-0`;
      await customers.attachGhanaCard(
        id,
        { ghana_card_number: card, ghana_card_image_key: 's3://b/k.jpg' },
        SYSTEM_ACTOR,
      );
      await customers.verifyGhanaCard(id, SYSTEM_ACTOR);

      const sig = await new IdentityCollector(db).collect(id);
      expect(sig.ghanaCardVerified).toBe(true);
      expect(sig.kycTier).toBe(1);
    });

    it('returns null age when no date of birth is on file', async () => {
      const id = await newCustomerId();
      const sig = await new IdentityCollector(db).collect(id);
      expect(sig.ageYears).toBeNull();
    });
  });

  describe('history collectors with no plans yet', () => {
    it('repayment reads a clean thin-file', async () => {
      const id = await newCustomerId();
      const sig = await new RepaymentCollector(db).collect(id);
      expect(sig).toEqual({
        completedPlansCount: 0,
        onTimePaymentRate: 1,
        averageDaysPastDue: 0,
        priorDefaults12mo: 0,
        priorDefaultsAllTime: 0,
        consecutiveOnTime: 0,
      });
    });

    it('behavior reads zero transaction history', async () => {
      const id = await newCustomerId();
      const sig = await new BehaviorCollector(db).collect(id);
      expect(sig).toEqual({
        successfulChargeCount: 0,
        momoTransactionShare: 0,
        averageTransactionGhs: 0,
        failedChargeRate90d: 0,
      });
    });

    it('tenure reads a non-negative account age', async () => {
      const id = await newCustomerId();
      const sig = await new TenureCollector(db).collect(id);
      expect(sig.accountAgeDays).toBeGreaterThanOrEqual(0);
      expect(sig.deviceFingerprintKnown).toBe(false);
    });
  });

  describe('EmploymentCollector', () => {
    it('returns unlinked defaults before any employment link', async () => {
      const id = await newCustomerId();
      const sig = await new EmploymentCollector(db).collect(id);
      expect(sig).toEqual({
        employerLinked: false,
        employerVerified: false,
        salaryBand: 'unknown',
        employmentMonths: null,
        payrollDeductionConsent: false,
      });
    });

    it('reflects an active employment link with payroll consent', async () => {
      const id = await newCustomerId();
      await employment.link(
        {
          customer_id: id,
          employer_id: employerId,
          salary_band: 'mid',
          employment_start_date: '2024-01-01',
          payroll_deduction_consent: true,
        },
        SYSTEM_ACTOR,
      );
      const sig = await new EmploymentCollector(db).collect(id);
      expect(sig.employerLinked).toBe(true);
      // A link is live the moment it is saved; verification is a separate act
      // and this one has not had it.
      expect(sig.employerVerified).toBe(false);
      expect(sig.salaryBand).toBe('mid');
      expect(sig.payrollDeductionConsent).toBe(true);
      expect(sig.employmentMonths!).toBeGreaterThanOrEqual(12);
    });
  });

  describe('ExposureCollector', () => {
    it('counts recent applications and reflects the blocklist flag', async () => {
      const id = await newCustomerId();
      const before = await new ExposureCollector(db).collect(id);
      expect(before).toEqual({
        activePlansCount: 0,
        outstandingBalanceGhs: 0,
        currentLimitGhs: 0,
        applicationsLast24h: 0,
        isOnBlocklist: false,
      });

      await apps.submit(submitInput(id), SYSTEM_ACTOR);
      await apps.submit(submitInput(id), SYSTEM_ACTOR);
      await customers.setBlocklist(id, { reason: 'fraud signal' }, SYSTEM_ACTOR);

      const after = await new ExposureCollector(db).collect(id);
      expect(after.applicationsLast24h).toBeGreaterThanOrEqual(2);
      expect(after.isOnBlocklist).toBe(true);
      expect(after.activePlansCount).toBe(0);
    });
  });

  describe('FeatureCollector orchestration', () => {
    it('assembles the full vector across every live collector', async () => {
      const id = await newCustomerId('1985-03-20');
      await employment.link(
        {
          customer_id: id,
          employer_id: employerId,
          salary_band: 'high',
          employment_start_date: '2023-01-01',
          payroll_deduction_consent: true,
        },
        SYSTEM_ACTOR,
      );
      await apps.submit(submitInput(id), SYSTEM_ACTOR);

      const request = {
        orderAmountGhs: 5_000,
        merchantCategory: 'electronics',
        planTemplateId,
        planMinGhs: 10,
        planMaxGhs: 100_000,
        downPaymentBps: 4_000,
      };
      const v = await FeatureCollector.fromDb(db).collect(id, request);

      expect(v.request).toEqual(request);
      expect(v.employment.employerLinked).toBe(true);
      expect(v.employment.payrollDeductionConsent).toBe(true);
      expect(v.exposure.applicationsLast24h).toBeGreaterThanOrEqual(1);
      expect(v.repayment.completedPlansCount).toBe(0);
      expect(typeof v.identity.ageYears).toBe('number');
      expect(v.tenure.accountAgeDays).toBeGreaterThanOrEqual(0);
    });
  });
});
