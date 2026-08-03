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
import { PlanDefaultError } from '../schedules/errors';
import { LedgerService } from '../../shared/ledger/ledger.service';
import { PayoutRecorder } from './payout-recorder';
import { ReserveReleaseService } from './reserve-release.service';
import { DefaultService } from './default.service';

const RUN_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!RUN_DB)('DefaultService (integration)', () => {
  const { db, pool } = createDb({ connectionString: process.env.DATABASE_URL! });
  const audit = new AuditLogger();
  const ledger = new LedgerService(db);
  const payouts = new PayoutRecorder(db, ledger);
  const reserves = new ReserveReleaseService(db, ledger);
  const defaults = new DefaultService(db, ledger, reserves);
  const merchants = new MerchantsService(db, audit);
  const customers = new CustomersService(db, audit, new MockGhanaCardVerifier());
  const planTemplates = new PlanTemplatesService(db, audit);
  const apps = new ApplicationsService(db, audit);
  const plans = new CustomerPlansService(db, audit, undefined, payouts, reserves, defaults);
  const ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  let bnplTemplateId: string;
  let rtoTemplateId: string;

  beforeAll(async () => {
    const suffix = randomUUID();
    bnplTemplateId = (
      await planTemplates.create(
        {
          name: `BNPL-def ${suffix}`,
          business_model: 'bnpl',
          number_of_installments: 4,
          installment_frequency_days: 7,
          min_amount_pesewas: 1_000,
          max_amount_pesewas: 10_000_000,
        },
        ACTOR,
      )
    ).id;
    rtoTemplateId = (
      await planTemplates.create(
        {
          name: `RTO-def ${suffix}`,
          business_model: 'rent_to_own',
          number_of_installments: 12,
          installment_frequency_days: 30,
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

  async function freshMerchant(): Promise<string> {
    const suffix = randomUUID();
    return (
      await merchants.create(
        {
          business_name: `M ${suffix}`,
          legal_name: `M Ltd ${suffix}`,
          email: `m+${suffix}@x.gh`,
          phone: '+233244000000',
        },
        ACTOR,
      )
    ).id;
  }

  async function freshCustomer(): Promise<string> {
    const suffix = randomUUID();
    return (
      await customers.register(
        {
          first_name: 'Default',
          last_name: 'Test',
          email: `d+${suffix}@x.gh`,
          phone: `024${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
        },
        ACTOR,
      )
    ).id;
  }

  async function activate(
    templateId: string,
    merchantId: string,
    customerId: string,
    order = 100_000,
  ) {
    const app = await apps.submit(
      {
        customer_id: customerId,
        merchant_id: merchantId,
        plan_template_id: templateId,
        order_reference: `ORD-${randomUUID()}`,
        order_amount_pesewas: order,
        merchant_category: 'electronics',
      },
      ACTOR,
    );
    await apps.recordDecision(app.id, { outcome: 'approved' }, ACTOR);
    return plans.activateFromApplication(app.id, ACTOR);
  }

  it('BNPL default: the reserve absorbs first, the platform pool takes the rest', async () => {
    const merchantId = await freshMerchant();
    const customerId = await freshCustomer();
    const { plan, schedule } = await activate(bnplTemplateId, merchantId, customerId);

    // Customer pays one installment, then defaults on the remaining 75k.
    await plans.recordManualPayment(schedule[0]!.id, {}, ACTOR);
    const before = await ledger.balanceOf('merchant_payable', merchantId);
    expect(await ledger.balanceOf('reserve_held', plan.id)).toBe(5_000);

    const updated = await plans.markPlanDefaulted(plan.id, { reason: 'no contact 90d' }, ACTOR);
    expect(updated.status).toBe('defaulted');
    expect(updated.defaulted_at).not.toBeNull();

    // The 5% withheld for default risk goes first; the platform pool covers the
    // remaining 70k. The merchant's payable is still untouched — BNPL caps its
    // exposure at the reserve rather than clawing back.
    expect(await ledger.balanceOf('reserve_held', plan.id)).toBe(0);
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(before);

    // 3 rows: receivable credit 75k = reserve debit 5k + pool debit 70k.
    const rows = await db
      .select()
      .from(schema.ledger_entries)
      .where(eq(schema.ledger_entries.transaction_id, `default:${plan.id}`));
    expect(rows).toHaveLength(3);
    const find = (type: string) => rows.find((r) => r.account_type === type)?.amount_pesewas;
    expect(find('receivable')).toBe(75_000);
    expect(find('reserve_held')).toBe(5_000);
    expect(find('default_pool')).toBe(70_000);
  });

  it('rent_to_own default: claws the reserve first, then the merchant payable', async () => {
    const merchantId = await freshMerchant();
    const customerId = await freshCustomer();
    const { plan } = await activate(rtoTemplateId, merchantId, customerId);

    // RTO accrues 100% on activation: 5% MDR, 12% reserve → net 83k payable, 12k reserve.
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(83_000);
    expect(await ledger.balanceOf('reserve_held', plan.id)).toBe(12_000);

    // Default the full 100k. Reserve (12k) absorbs first; remaining 88k claws the merchant.
    await plans.markPlanDefaulted(plan.id, {}, ACTOR);

    expect(await ledger.balanceOf('reserve_held', plan.id)).toBe(0); // fully consumed
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(83_000 - 88_000); // −5_000

    // held_reserves row marked consumed + closed.
    const held = (
      await db
        .select()
        .from(schema.held_reserves)
        .where(eq(schema.held_reserves.customer_plan_id, plan.id))
    )[0];
    expect(held!.consumed_for_default_pesewas).toBe(12_000);
    expect(held!.fully_released_at).not.toBeNull();
  });

  it('rent_to_own default caps the reserve draw at what is still held', async () => {
    const merchantId = await freshMerchant();
    const customerId = await freshCustomer();
    const { plan } = await activate(rtoTemplateId, merchantId, customerId);

    // Default only 8k — less than the 12k reserve, so nothing claws the merchant.
    await plans.markPlanDefaulted(plan.id, { unrecoveredAmountPesewas: 8_000 }, ACTOR);

    expect(await ledger.balanceOf('reserve_held', plan.id)).toBe(12_000 - 8_000); // 4k left
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(83_000); // untouched

    const held = (
      await db
        .select()
        .from(schema.held_reserves)
        .where(eq(schema.held_reserves.customer_plan_id, plan.id))
    )[0];
    expect(held!.consumed_for_default_pesewas).toBe(8_000);
    expect(held!.fully_released_at).toBeNull(); // still has reserve to release
  });

  it('refuses to default a plan that is not active, and is idempotent on the ledger', async () => {
    const merchantId = await freshMerchant();
    const customerId = await freshCustomer();
    const { plan } = await activate(bnplTemplateId, merchantId, customerId);

    await plans.markPlanDefaulted(plan.id, {}, ACTOR);
    // Second attempt: plan is no longer active.
    await expect(plans.markPlanDefaulted(plan.id, {}, ACTOR)).rejects.toBeInstanceOf(
      PlanDefaultError,
    );
    // Only one default transaction was ever booked (receivable + reserve + pool).
    const rows = await db
      .select()
      .from(schema.ledger_entries)
      .where(eq(schema.ledger_entries.transaction_id, `default:${plan.id}`));
    expect(rows).toHaveLength(3);
  });

  it('handleDefault is a no-op for a zero unrecovered amount', async () => {
    const merchantId = await freshMerchant();
    const result = await defaults.handleDefault({
      customerPlanId: randomUUID(),
      merchantId,
      model: 'bnpl',
      unrecoveredAmountPesewas: 0,
    });
    expect(result).toBeNull();
  });

  it('a defaulted reserve is no longer released by the reserve sweep', async () => {
    const merchantId = await freshMerchant();
    const customerId = await freshCustomer();
    const { plan } = await activate(rtoTemplateId, merchantId, customerId);

    // Default consumes the entire 12k reserve.
    await plans.markPlanDefaulted(plan.id, {}, ACTOR);
    expect(await ledger.balanceOf('reserve_held', plan.id)).toBe(0);

    // Rolling release far in the future finds nothing left to release for the plan.
    const summary = await reserves.releaseMaturedReserves(
      merchantId,
      new Date(Date.now() + 400 * 86_400_000),
    );
    const planRelease = summary.releases.find((r) => r.customerPlanId === plan.id);
    expect(planRelease?.releasedPesewas ?? 0).toBe(0);
    expect(await ledger.balanceOf('reserve_held', plan.id)).toBe(0);
  });
});
