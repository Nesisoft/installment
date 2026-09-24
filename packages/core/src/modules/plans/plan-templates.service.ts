import { and, desc, eq, gt, isNull, lte, or } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import { AuditLogger, type AuditActorType } from '../audit/audit-logger.service';
import { runInTransaction } from '../../shared/event-bus/transaction';
import {
  createPlanTemplateSchema,
  listPlanTemplatesSchema,
  updatePlanTemplateSchema,
  type CreatePlanTemplateInput,
  type ListPlanTemplatesInput,
  type UpdatePlanTemplateInput,
} from './dto';
import { PlanTemplateNotFoundError } from './errors';

const p = schema.plan_templates;

export type PlanTemplate = typeof schema.plan_templates.$inferSelect;

export interface PlanTemplateActor {
  actorId: string;
  actorType: AuditActorType;
}

export class PlanTemplatesService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditLogger,
  ) {}

  async create(rawInput: unknown, actor: PlanTemplateActor): Promise<PlanTemplate> {
    const input: CreatePlanTemplateInput = createPlanTemplateSchema.parse(rawInput);
    return runInTransaction(this.db, async (tx) => {
      const [row] = await tx
        .insert(p)
        .values({
          name: input.name,
          description: input.description,
          business_model: input.business_model,
          number_of_installments: input.number_of_installments,
          installment_frequency_days: input.installment_frequency_days,
          down_payment_bps: input.down_payment_bps,
          interest_rate_bps: input.interest_rate_bps,
          service_fee_flat_pesewas: input.service_fee_flat_pesewas,
          late_fee_pesewas: input.late_fee_pesewas,
          late_fee_bps_per_week: input.late_fee_bps_per_week,
          late_fee_cap_bps: input.late_fee_cap_bps,
          grace_period_days: input.grace_period_days,
          min_amount_pesewas: input.min_amount_pesewas,
          max_amount_pesewas: input.max_amount_pesewas,
          eligible_categories: input.eligible_categories,
          excluded_categories: input.excluded_categories,
          effective_from: input.effective_from,
          effective_to: input.effective_to,
        })
        .returning();
      if (!row) throw new Error('plan_templates insert returned no row');

      await this.audit.append(tx, {
        entityType: 'plan_template',
        entityId: row.id,
        eventType: 'plan_template.created',
        actorId: actor.actorId,
        actorType: actor.actorType,
        metadata: {
          business_model: row.business_model,
          number_of_installments: row.number_of_installments,
        },
      });
      return row;
    });
  }

  async list(rawInput: unknown = {}): Promise<PlanTemplate[]> {
    const input: ListPlanTemplatesInput = listPlanTemplatesSchema.parse(rawInput);
    const where = [];
    if (input.business_model) where.push(eq(p.business_model, input.business_model));
    if (input.is_active !== undefined) where.push(eq(p.is_active, input.is_active));
    if (input.effective_at) {
      where.push(lte(p.effective_from, input.effective_at));
      where.push(or(isNull(p.effective_to), gt(p.effective_to, input.effective_at))!);
    }
    const query = this.db.select().from(p);
    const filtered = where.length ? query.where(and(...where)) : query;
    return filtered.orderBy(desc(p.created_at)).limit(input.limit).offset(input.offset);
  }

  async get(id: string): Promise<PlanTemplate> {
    const rows = await this.db.select().from(p).where(eq(p.id, id)).limit(1);
    const row = rows[0];
    if (!row) throw new PlanTemplateNotFoundError(id);
    return row;
  }

  async update(id: string, rawPatch: unknown, actor: PlanTemplateActor): Promise<PlanTemplate> {
    const patch: UpdatePlanTemplateInput = updatePlanTemplateSchema.parse(rawPatch);
    return runInTransaction(this.db, async (tx) => {
      const rows = await tx
        .update(p)
        .set({ ...patch })
        .where(eq(p.id, id))
        .returning();
      const row = rows[0];
      if (!row) throw new PlanTemplateNotFoundError(id);

      await this.audit.append(tx, {
        entityType: 'plan_template',
        entityId: id,
        eventType: 'plan_template.updated',
        actorId: actor.actorId,
        actorType: actor.actorType,
        metadata: { fields: Object.keys(patch) },
      });
      return row;
    });
  }

  /** Soft-disable a template (is_active=false). Existing customer_plans are unaffected. */
  async deactivate(id: string, actor: PlanTemplateActor): Promise<PlanTemplate> {
    return runInTransaction(this.db, async (tx) => {
      const rows = await tx
        .update(p)
        .set({ is_active: false })
        .where(and(eq(p.id, id), eq(p.is_active, true)))
        .returning();
      const row = rows[0];
      if (!row) {
        // Differentiate: not found vs. already inactive.
        const exists = await tx.select({ id: p.id }).from(p).where(eq(p.id, id)).limit(1);
        if (!exists[0]) throw new PlanTemplateNotFoundError(id);
        // Already inactive — return the existing row idempotently.
        const current = await tx.select().from(p).where(eq(p.id, id)).limit(1);
        return current[0]!;
      }
      await this.audit.append(tx, {
        entityType: 'plan_template',
        entityId: id,
        eventType: 'plan_template.deactivated',
        actorId: actor.actorId,
        actorType: actor.actorType,
      });
      return row;
    });
  }

  async activate(id: string, actor: PlanTemplateActor): Promise<PlanTemplate> {
    return runInTransaction(this.db, async (tx) => {
      const rows = await tx
        .update(p)
        .set({ is_active: true })
        .where(and(eq(p.id, id), eq(p.is_active, false)))
        .returning();
      const row = rows[0];
      if (!row) {
        const exists = await tx.select({ id: p.id }).from(p).where(eq(p.id, id)).limit(1);
        if (!exists[0]) throw new PlanTemplateNotFoundError(id);
        const current = await tx.select().from(p).where(eq(p.id, id)).limit(1);
        return current[0]!;
      }
      await this.audit.append(tx, {
        entityType: 'plan_template',
        entityId: id,
        eventType: 'plan_template.activated',
        actorId: actor.actorId,
        actorType: actor.actorType,
      });
      return row;
    });
  }

  /**
   * Check eligibility for an order against an active, currently-effective plan
   * template. Returns either { ok: true } or { ok: false, reason }.
   */
  async checkEligibility(args: {
    template_id: string;
    order_amount_pesewas: number;
    merchant_category: string;
    at?: string;
  }): Promise<
    { ok: true; template: PlanTemplate } | { ok: false; reason: string; template?: PlanTemplate }
  > {
    const template = await this.get(args.template_id);
    const at = args.at ?? new Date().toISOString();

    if (!template.is_active) return { ok: false, reason: 'template_inactive', template };
    if (template.effective_from > at) {
      return { ok: false, reason: 'not_yet_effective', template };
    }
    if (template.effective_to && template.effective_to <= at) {
      return { ok: false, reason: 'effective_expired', template };
    }
    if (args.order_amount_pesewas < template.min_amount_pesewas) {
      return { ok: false, reason: 'below_min_amount', template };
    }
    if (args.order_amount_pesewas > template.max_amount_pesewas) {
      return { ok: false, reason: 'above_max_amount', template };
    }
    if (
      template.excluded_categories.length > 0 &&
      template.excluded_categories.includes(args.merchant_category)
    ) {
      return { ok: false, reason: 'category_excluded', template };
    }
    if (
      template.eligible_categories.length > 0 &&
      !template.eligible_categories.includes(args.merchant_category)
    ) {
      return { ok: false, reason: 'category_not_eligible', template };
    }
    return { ok: true, template };
  }
}
