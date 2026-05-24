import { desc, eq } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import { AuditLogger, type AuditActorType } from '../audit/audit-logger.service';
import { runInTransaction } from '../../shared/event-bus/transaction';
import { ScheduleGenerator, type ScheduleBusinessModel } from './schedule-generator';
import { CustomerPlanNotFoundError, PlanActivationError, PlanAlreadyActiveError } from './errors';

const cp = schema.customer_plans;
const sched = schema.installment_schedule;
const apps = schema.applications;
const templates = schema.plan_templates;
const merchants = schema.merchants;

export type CustomerPlan = typeof schema.customer_plans.$inferSelect;
export type InstallmentScheduleRow = typeof schema.installment_schedule.$inferSelect;

export interface PlanActor {
  actorId: string;
  actorType: AuditActorType;
}

export interface ActivatedPlan {
  plan: CustomerPlan;
  schedule: InstallmentScheduleRow[];
}

/**
 * Owns the `customer_plans` lifecycle. Activation turns an approved application
 * into an active plan plus its full installment schedule, atomically: the plan
 * row, every schedule row, and the audit entry commit together.
 */
export class CustomerPlansService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditLogger,
    private readonly generator: ScheduleGenerator = new ScheduleGenerator(),
  ) {}

  async activateFromApplication(
    applicationId: string,
    actor: PlanActor,
    now: Date = new Date(),
  ): Promise<ActivatedPlan> {
    const application = (
      await this.db.select().from(apps).where(eq(apps.id, applicationId)).limit(1)
    )[0];
    if (!application) throw new PlanActivationError(`Application ${applicationId} not found`);
    if (application.status !== 'approved') {
      throw new PlanActivationError(
        `Application ${applicationId} is "${application.status}", not approved`,
      );
    }

    const template = (
      await this.db
        .select()
        .from(templates)
        .where(eq(templates.id, application.plan_template_id))
        .limit(1)
    )[0];
    if (!template) {
      throw new PlanActivationError(`Plan template ${application.plan_template_id} not found`);
    }

    const merchant = (
      await this.db
        .select({ mdr: merchants.default_mdr_bps, reserve: merchants.default_reserve_bps })
        .from(merchants)
        .where(eq(merchants.id, application.merchant_id))
        .limit(1)
    )[0];
    if (!merchant) throw new PlanActivationError(`Merchant ${application.merchant_id} not found`);

    // Schedule is derived from the template's terms. (Accepted counter-offer
    // amounts on the application are honoured in a later refinement.)
    const generated = this.generator.generate({
      businessModel: template.business_model as ScheduleBusinessModel,
      orderAmountPesewas: application.order_amount_pesewas,
      downPaymentBps: template.down_payment_bps,
      interestRateBps: template.interest_rate_bps,
      serviceFeeFlatPesewas: template.service_fee_flat_pesewas,
      numberOfInstallments: template.number_of_installments,
      installmentFrequencyDays: template.installment_frequency_days,
      gracePeriodDays: template.grace_period_days,
      startDate: now,
    });

    const nowIso = now.toISOString();

    return runInTransaction(this.db, async (tx) => {
      const existing = await tx
        .select({ id: cp.id })
        .from(cp)
        .where(eq(cp.application_id, applicationId))
        .limit(1);
      if (existing[0]) throw new PlanAlreadyActiveError(applicationId);

      const [plan] = await tx
        .insert(cp)
        .values({
          customer_id: application.customer_id,
          merchant_id: application.merchant_id,
          plan_template_id: application.plan_template_id,
          application_id: applicationId,
          business_model: template.business_model,
          number_of_installments: template.number_of_installments,
          installment_frequency_days: template.installment_frequency_days,
          grace_period_days: template.grace_period_days,
          mdr_bps: merchant.mdr,
          reserve_bps: merchant.reserve,
          order_amount_pesewas: application.order_amount_pesewas,
          down_payment_pesewas: generated.downPaymentPesewas,
          financed_amount_pesewas: generated.financedAmountPesewas,
          total_interest_pesewas: generated.totalInterestPesewas,
          total_fees_pesewas: generated.totalFeesPesewas,
          total_payable_pesewas: generated.totalPayablePesewas,
          outstanding_pesewas: generated.totalPayablePesewas,
          status: 'active',
          approved_at: nowIso,
          activated_at: nowIso,
        })
        .returning();
      if (!plan) throw new Error('customer_plans insert returned no row');

      const schedule = await tx
        .insert(sched)
        .values(
          generated.installments.map((i) => ({
            customer_plan_id: plan.id,
            sequence_number: i.sequenceNumber,
            amount_due_pesewas: i.amountDuePesewas,
            due_date: i.dueDate,
            grace_until_date: i.graceUntilDate,
          })),
        )
        .returning();

      await this.audit.append(tx, {
        entityType: 'customer_plan',
        entityId: plan.id,
        eventType: 'customer_plan.activated',
        toState: 'active',
        actorId: actor.actorId,
        actorType: actor.actorType,
        metadata: {
          application_id: applicationId,
          installments: schedule.length,
          total_payable_pesewas: generated.totalPayablePesewas,
        },
      });

      schedule.sort((a, b) => a.sequence_number - b.sequence_number);
      return { plan, schedule };
    });
  }

  async get(id: string): Promise<CustomerPlan> {
    const row = (await this.db.select().from(cp).where(eq(cp.id, id)).limit(1))[0];
    if (!row) throw new CustomerPlanNotFoundError(id);
    return row;
  }

  async listForCustomer(customerId: string): Promise<CustomerPlan[]> {
    return this.db
      .select()
      .from(cp)
      .where(eq(cp.customer_id, customerId))
      .orderBy(desc(cp.created_at));
  }

  /** The installment rows for a plan, ordered by sequence. */
  async getSchedule(planId: string): Promise<InstallmentScheduleRow[]> {
    return this.db
      .select()
      .from(sched)
      .where(eq(sched.customer_plan_id, planId))
      .orderBy(sched.sequence_number);
  }
}
