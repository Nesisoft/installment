import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDb, schema } from '@installment/db';
import { AuditLogger } from '../audit/audit-logger.service';
import { SYSTEM_ACTORS } from '../../shared/constants/system-actors';
import { MerchantsService } from './merchants.service';
import { CustomersService } from '../customers/customers.service';
import { MockGhanaCardVerifier } from '../customers/ghana-card-verifier';
import { PlanTemplatesService } from '../plans/plan-templates.service';
import { ApplicationsService } from '../applications/applications.service';
import { CustomerPlansService } from '../schedules/customer-plans.service';

const RUN_DB = Boolean(process.env.DATABASE_URL);

/**
 * A negotiated rate, from the admin form to the plan it prices.
 *
 * Migration 0009 made `mdr_bps_override` / `reserve_bps_override` the columns
 * activation reads: NULL means "charge this business model's own rate", a
 * value means a deal. It did not give them a writer. The create and update
 * schemas accepted only `default_mdr_bps` / `default_reserve_bps`, which 0009
 * itself demoted to display — so the admin console's "MDR bps" field stored a
 * number nothing charged, and every merchant, whatever was agreed with them,
 * paid the model rate. Zod strips unknown keys, so sending the override by hand
 * did not even fail; it vanished.
 */
describe.skipIf(!RUN_DB)('negotiated merchant rates (integration)', () => {
  const { db, pool } = createTestDb();
  const audit = new AuditLogger();
  const merchants = new MerchantsService(db, audit);
  const customers = new CustomersService(db, audit, new MockGhanaCardVerifier());
  const planTemplates = new PlanTemplatesService(db, audit);
  const apps = new ApplicationsService(db, audit);
  const plans = new CustomerPlansService(db, audit);
  const ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  const templateIds = {} as Record<'bnpl' | 'layaway', string>;

  beforeAll(async () => {
    for (const model of ['bnpl', 'layaway'] as const) {
      templateIds[model] = (
        await planTemplates.create(
          {
            name: `Rates ${model} ${randomUUID()}`,
            business_model: model,
            number_of_installments: 4,
            installment_frequency_days: 7,
            min_amount_pesewas: 1_000,
            max_amount_pesewas: 10_000_000,
          },
          ACTOR,
        )
      ).id;
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  async function merchant(terms: Record<string, unknown> = {}) {
    const s = randomUUID();
    return merchants.create(
      {
        business_name: `Rates ${s}`,
        legal_name: `Rates Ltd ${s}`,
        email: `rates+${s}@x.gh`,
        phone: `+2332${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
        ...terms,
      },
      ACTOR,
    );
  }

  /** Activates one plan for the merchant and returns the rates frozen onto it. */
  async function planFor(merchantId: string, model: 'bnpl' | 'layaway') {
    const s = randomUUID();
    const customer = await customers.register(
      {
        first_name: 'Rate',
        last_name: 'Payer',
        email: `rp+${s}@x.gh`,
        phone: `024${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
      },
      ACTOR,
    );
    const app = await apps.submit(
      {
        customer_id: customer.id,
        merchant_id: merchantId,
        plan_template_id: templateIds[model],
        order_reference: `ORD-${randomUUID()}`,
        order_amount_pesewas: 100_000,
        merchant_category: 'electronics',
      },
      ACTOR,
    );
    await apps.recordDecision(app.id, { outcome: 'approved' }, ACTOR);
    const { plan } = await plans.activateFromApplication(app.id, ACTOR);
    return plan;
  }

  it('charges a negotiated MDR on the plans that follow', async () => {
    const m = await merchant({ mdr_bps_override: 250 });
    expect(m.mdr_bps_override).toBe(250);
    // Only the MDR was negotiated; the reserve stays the model's own.
    expect(m.reserve_bps_override).toBeNull();

    const plan = await planFor(m.id, 'layaway');
    expect(plan.mdr_bps).toBe(250); // the deal, not layaway's 3%
    expect(plan.reserve_bps).toBe(200); // layaway's 2%, not a flat 5%
  });

  it('charges the business model rate when nothing was negotiated', async () => {
    const m = await merchant();
    expect(m.mdr_bps_override).toBeNull();
    expect(m.reserve_bps_override).toBeNull();

    const bnpl = await planFor(m.id, 'bnpl');
    expect([bnpl.mdr_bps, bnpl.reserve_bps]).toEqual([400, 500]);
    const layaway = await planFor(m.id, 'layaway');
    expect([layaway.mdr_bps, layaway.reserve_bps]).toEqual([300, 200]);
  });

  it('treats a negotiated 0% as a rate, not as "nothing negotiated"', async () => {
    const m = await merchant({ mdr_bps_override: 0, reserve_bps_override: 0 });
    const plan = await planFor(m.id, 'bnpl');
    expect([plan.mdr_bps, plan.reserve_bps]).toEqual([0, 0]);
  });

  it('changes terms going forward only, and clearing them restores the model rate', async () => {
    const m = await merchant();
    const before = await planFor(m.id, 'bnpl');

    await merchants.update(m.id, { mdr_bps_override: 250, reserve_bps_override: 100 }, ACTOR);
    const during = await planFor(m.id, 'bnpl');
    expect([during.mdr_bps, during.reserve_bps]).toEqual([250, 100]);

    // An append-only ledger has already booked accruals at the old rate; the
    // plan that carried them must keep it.
    const [reread] = await db
      .select()
      .from(schema.customer_plans)
      .where(eq(schema.customer_plans.id, before.id));
    expect([reread!.mdr_bps, reread!.reserve_bps]).toEqual([400, 500]);

    // NULL is how a deal ends — not a number that happens to equal today's
    // model rate, which would silently stop tracking it.
    const cleared = await merchants.update(
      m.id,
      { mdr_bps_override: null, reserve_bps_override: null },
      ACTOR,
    );
    expect(cleared.mdr_bps_override).toBeNull();
    expect(cleared.reserve_bps_override).toBeNull();
    const after = await planFor(m.id, 'bnpl');
    expect([after.mdr_bps, after.reserve_bps]).toEqual([400, 500]);
  });

  it('leaves the terms alone when an update does not mention them', async () => {
    const m = await merchant({ mdr_bps_override: 250 });
    const renamed = await merchants.update(m.id, { business_name: `Renamed ${m.id}` }, ACTOR);
    expect(renamed.mdr_bps_override).toBe(250);
  });

  it('answers a patch with nothing in it instead of crashing on an empty SET', async () => {
    // Zod strips unknown keys, so `{}` and a body of nothing but typos both
    // arrive empty. Drizzle threw "No values to set", which was a 500.
    const m = await merchant({ mdr_bps_override: 250 });
    const same = await merchants.update(m.id, { not_a_field: 1 }, ACTOR);
    expect(same.id).toBe(m.id);
    expect(same.mdr_bps_override).toBe(250);
  });

  it('refuses a rate the column could not hold', async () => {
    await expect(merchant({ mdr_bps_override: 2_001 })).rejects.toThrow();
    const m = await merchant();
    await expect(merchants.update(m.id, { reserve_bps_override: 5_001 }, ACTOR)).rejects.toThrow();
    await expect(merchants.update(m.id, { mdr_bps_override: 2.5 }, ACTOR)).rejects.toThrow();
  });

  it('records a negotiated pay-now commission, and clears it with NULL', async () => {
    const m = await merchant({ commission_bps_override: 300 });
    expect(m.commission_bps_override).toBe(300);
    const cleared = await merchants.update(m.id, { commission_bps_override: null }, ACTOR);
    expect(cleared.commission_bps_override).toBeNull();
    await expect(
      merchants.update(m.id, { commission_bps_override: 2_001 }, ACTOR),
    ).rejects.toThrow();
  });

  it('records what the terms were changed to, not just that something changed', async () => {
    const m = await merchant();
    await merchants.update(m.id, { mdr_bps_override: 275 }, ACTOR);

    const [event] = await db
      .select()
      .from(schema.audit_events)
      .where(
        and(
          eq(schema.audit_events.entity_id, m.id),
          eq(schema.audit_events.event_type, 'merchant.updated'),
        ),
      );
    expect(event?.metadata).toMatchObject({
      terms: { mdr_bps_override: 275, commission_bps_override: null },
    });
  });
});
