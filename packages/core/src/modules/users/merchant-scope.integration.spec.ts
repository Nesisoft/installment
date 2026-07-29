import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '@installment/db';
import { AuditLogger } from '../audit/audit-logger.service';
import { PasswordService } from '../../shared/auth/password.service';
import { SYSTEM_ACTORS } from '../../shared/constants/system-actors';
import { MerchantsService } from '../merchants/merchants.service';
import { CustomersService } from '../customers/customers.service';
import { MockGhanaCardVerifier } from '../customers/ghana-card-verifier';
import { PlanTemplatesService } from '../plans/plan-templates.service';
import { ApplicationsService } from '../applications/applications.service';
import { CustomerPlansService } from '../schedules/customer-plans.service';
import { UsersService } from './users.service';

const RUN_DB = Boolean(process.env.DATABASE_URL);
const ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

describe.skipIf(!RUN_DB)('Merchant scoping (integration)', () => {
  const { db, pool } = createDb({ connectionString: process.env.DATABASE_URL! });
  const audit = new AuditLogger();
  const users = new UsersService(db, audit, new PasswordService());
  const merchants = new MerchantsService(db, audit);
  const customers = new CustomersService(db, audit, new MockGhanaCardVerifier());
  const planTemplates = new PlanTemplatesService(db, audit);
  const apps = new ApplicationsService(db, audit);
  const plans = new CustomerPlansService(db, audit);

  let templateId: string;

  beforeAll(async () => {
    templateId = (
      await planTemplates.create(
        {
          name: `BNPL-scope ${randomUUID()}`,
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

  function newMerchant() {
    const s = randomUUID();
    return merchants.create(
      {
        business_name: `M ${s}`,
        legal_name: `M ${s}`,
        email: `m+${s}@x.gh`,
        phone: '+233244000000',
      },
      ACTOR,
    );
  }

  it('createMerchantUser links the user to its merchant and getMerchantScope resolves it', async () => {
    const merchant = await newMerchant();
    const user = await users.createMerchantUser(
      {
        email: `owner+${randomUUID()}@x.gh`,
        name: 'Owner',
        password: 'password123',
        merchant_id: merchant.id,
      },
      ACTOR,
    );
    expect(user.user_type).toBe('merchant');
    expect(await users.getMerchantScope(user.id)).toBe(merchant.id);
  });

  it('getMerchantScope returns null for a non-merchant user', async () => {
    const staff = await users.createStaff(
      {
        email: `staff+${randomUUID()}@x.gh`,
        name: 'Staff',
        password: 'password123',
        user_type: 'admin',
      },
      ACTOR,
    );
    expect(await users.getMerchantScope(staff.id)).toBeNull();
  });

  it('getMerchantScope returns null for a merchant user with no merchant linked', async () => {
    const user = await users.createMerchantUser(
      { email: `nolink+${randomUUID()}@x.gh`, name: 'NoLink', password: 'password123' },
      ACTOR,
    );
    expect(await users.getMerchantScope(user.id)).toBeNull();
  });

  it('listByMerchant returns only that merchant’s plans', async () => {
    const merchantA = await newMerchant();
    const merchantB = await newMerchant();
    const customer = await customers.register(
      {
        first_name: 'Scope',
        last_name: 'Test',
        email: `c+${randomUUID()}@x.gh`,
        phone: `024${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
      },
      ACTOR,
    );
    const app = await apps.submit(
      {
        customer_id: customer.id,
        merchant_id: merchantA.id,
        plan_template_id: templateId,
        order_reference: `ORD-${randomUUID()}`,
        order_amount_pesewas: 100_000,
        merchant_category: 'electronics',
      },
      ACTOR,
    );
    await apps.recordDecision(app.id, { outcome: 'approved' }, ACTOR);
    const { plan } = await plans.activateFromApplication(app.id, ACTOR);

    const forA = await plans.listByMerchant(merchantA.id);
    const forB = await plans.listByMerchant(merchantB.id);
    expect(forA.some((p) => p.id === plan.id)).toBe(true);
    expect(forB.some((p) => p.id === plan.id)).toBe(false);
  });
});
