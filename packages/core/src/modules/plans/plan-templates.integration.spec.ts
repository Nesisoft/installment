import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import { createTestDb, schema } from '@installment/db';
import { AuditLogger } from '../audit/audit-logger.service';
import { SYSTEM_ACTORS } from '../../shared/constants/system-actors';
import { PlanTemplatesService } from './plan-templates.service';
import { PlanTemplateNotFoundError } from './errors';

const RUN_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!RUN_DB)('PlanTemplatesService (integration)', () => {
  const { db, pool } = createTestDb();
  const audit = new AuditLogger();
  const service = new PlanTemplatesService(db, audit);
  const SYSTEM_ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  afterAll(async () => {
    await pool.end();
  });

  function bnplInput() {
    return {
      name: `BNPL 4×weekly ${randomUUID()}`,
      business_model: 'bnpl' as const,
      number_of_installments: 4,
      installment_frequency_days: 7 as const,
      min_amount_pesewas: 10_000,
      max_amount_pesewas: 1_000_000,
      interest_rate_bps: 0,
      eligible_categories: ['electronics', 'fashion'],
      excluded_categories: ['firearms'],
    };
  }

  async function lastAuditEventType(id: string): Promise<string | undefined> {
    const rows = await db
      .select({ event_type: schema.audit_events.event_type })
      .from(schema.audit_events)
      .where(eq(schema.audit_events.entity_id, id))
      .orderBy(desc(schema.audit_events.occurred_at))
      .limit(1);
    return rows[0]?.event_type;
  }

  it('creates a plan template with defaults and audits creation', async () => {
    const created = await service.create(bnplInput(), SYSTEM_ACTOR);
    expect(created.business_model).toBe('bnpl');
    expect(created.is_active).toBe(true);
    expect(created.grace_period_days).toBe(3);
    expect(created.eligible_categories).toContain('electronics');
    expect(await lastAuditEventType(created.id)).toBe('plan_template.created');
  });

  it('rejects max < min at the DB CHECK if the DTO is bypassed', async () => {
    await expect(
      db.insert(schema.plan_templates).values({
        name: 'bad',
        business_model: 'bnpl',
        number_of_installments: 1,
        installment_frequency_days: 7,
        min_amount_pesewas: 1_000_000,
        max_amount_pesewas: 1_000,
      }),
    ).rejects.toThrow();
  });

  it('updates non-structural fields and audits the change', async () => {
    const created = await service.create(bnplInput(), SYSTEM_ACTOR);
    const updated = await service.update(
      created.id,
      { name: 'Renamed', service_fee_flat_pesewas: 500 },
      SYSTEM_ACTOR,
    );
    expect(updated.name).toBe('Renamed');
    expect(updated.service_fee_flat_pesewas).toBe(500);
    expect(await lastAuditEventType(created.id)).toBe('plan_template.updated');
  });

  it('deactivates and re-activates idempotently with audit', async () => {
    const created = await service.create(bnplInput(), SYSTEM_ACTOR);

    const off = await service.deactivate(created.id, SYSTEM_ACTOR);
    expect(off.is_active).toBe(false);
    expect(await lastAuditEventType(created.id)).toBe('plan_template.deactivated');

    // Second deactivate is a no-op idempotent return.
    const off2 = await service.deactivate(created.id, SYSTEM_ACTOR);
    expect(off2.is_active).toBe(false);

    const on = await service.activate(created.id, SYSTEM_ACTOR);
    expect(on.is_active).toBe(true);
    expect(await lastAuditEventType(created.id)).toBe('plan_template.activated');
  });

  it('lists by is_active and by effective_at window', async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const farPast = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const recentPast = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    const futureRow = await service.create(
      { ...bnplInput(), effective_from: future },
      SYSTEM_ACTOR,
    );
    const expiredRow = await service.create(
      { ...bnplInput(), effective_from: farPast, effective_to: recentPast },
      SYSTEM_ACTOR,
    );
    const liveRow = await service.create(bnplInput(), SYSTEM_ACTOR);

    const now = new Date().toISOString();
    const live = await service.list({ effective_at: now, business_model: 'bnpl', limit: 200 });
    const liveIds = live.map((r) => r.id);
    expect(liveIds).toContain(liveRow.id);
    expect(liveIds).not.toContain(futureRow.id);
    expect(liveIds).not.toContain(expiredRow.id);
  });

  it('evaluates eligibility for amount and merchant_category', async () => {
    const tpl = await service.create(bnplInput(), SYSTEM_ACTOR);

    const ok = await service.checkEligibility({
      template_id: tpl.id,
      order_amount_pesewas: 500_000,
      merchant_category: 'electronics',
    });
    expect(ok.ok).toBe(true);

    const tooSmall = await service.checkEligibility({
      template_id: tpl.id,
      order_amount_pesewas: 100,
      merchant_category: 'electronics',
    });
    expect(tooSmall).toMatchObject({ ok: false, reason: 'below_min_amount' });

    const tooBig = await service.checkEligibility({
      template_id: tpl.id,
      order_amount_pesewas: 10_000_000,
      merchant_category: 'electronics',
    });
    expect(tooBig).toMatchObject({ ok: false, reason: 'above_max_amount' });

    const excluded = await service.checkEligibility({
      template_id: tpl.id,
      order_amount_pesewas: 500_000,
      merchant_category: 'firearms',
    });
    expect(excluded).toMatchObject({ ok: false, reason: 'category_excluded' });

    const offCat = await service.checkEligibility({
      template_id: tpl.id,
      order_amount_pesewas: 500_000,
      merchant_category: 'groceries',
    });
    expect(offCat).toMatchObject({ ok: false, reason: 'category_not_eligible' });
  });

  it('rejects eligibility for an inactive or out-of-window template', async () => {
    const tpl = await service.create(bnplInput(), SYSTEM_ACTOR);
    await service.deactivate(tpl.id, SYSTEM_ACTOR);
    const r = await service.checkEligibility({
      template_id: tpl.id,
      order_amount_pesewas: 500_000,
      merchant_category: 'electronics',
    });
    expect(r).toMatchObject({ ok: false, reason: 'template_inactive' });
  });

  it('throws PlanTemplateNotFoundError on unknown IDs', async () => {
    await expect(service.get(randomUUID())).rejects.toBeInstanceOf(PlanTemplateNotFoundError);
    await expect(service.update(randomUUID(), { name: 'x' }, SYSTEM_ACTOR)).rejects.toBeInstanceOf(
      PlanTemplateNotFoundError,
    );
  });
});
