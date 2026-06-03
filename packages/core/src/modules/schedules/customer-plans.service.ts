import { and, desc, eq } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import { AuditLogger, type AuditActorType } from '../audit/audit-logger.service';
import { runInTransaction, type TransactionalTx } from '../../shared/event-bus/transaction';
import { ScheduleGenerator, type ScheduleBusinessModel } from './schedule-generator';
import { SCHEDULE_TERMINAL_STATES, nextScheduleStatus, type ScheduleStatus } from './state-machine';
import { recordManualPaymentSchema } from './dto';
import {
  CustomerPlanNotFoundError,
  InstallmentNotPayableError,
  PlanActivationError,
  PlanAlreadyActiveError,
  ReceiptNotAvailableError,
  ScheduleConcurrencyError,
  ScheduleNotFoundError,
} from './errors';
import { buildStatement, type Statement } from '../statements/statement';
import { buildReceipt, type Receipt } from '../receipts/receipt';
import type { PayoutRecorder, RecordPayoutAccrualInput } from '../settlements/payout-recorder';
import type { ReserveReleaseService } from '../settlements/reserve-release.service';
import type { BusinessModel } from '../settlements/model-config';

const cp = schema.customer_plans;
const sched = schema.installment_schedule;
const apps = schema.applications;
const templates = schema.plan_templates;
const merchants = schema.merchants;
const customers = schema.customers;

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

export interface ManualPaymentResult {
  schedule: InstallmentScheduleRow;
  plan: CustomerPlan;
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
    /**
     * Books merchant payout accruals as plans hit their model-defined triggers.
     * Optional so framework-free callers / tests can omit settlement plumbing.
     */
    private readonly payoutRecorder?: PayoutRecorder,
    /**
     * Tracks the reserve withheld by each accrual for later release. Wired
     * alongside {@link payoutRecorder}; optional for the same reason.
     */
    private readonly reserveRelease?: ReserveReleaseService,
  ) {}

  /**
   * Books one accrual and, when it withholds reserve, records the matching
   * held-reserve tracking row — both inside the caller's transaction. Returns
   * nothing; callers fire it per trigger.
   */
  private async accrueAndTrack(
    tx: TransactionalTx,
    input: RecordPayoutAccrualInput,
    heldAt: Date,
  ): Promise<void> {
    if (!this.payoutRecorder) return;
    const breakdown = await this.payoutRecorder.recordPayoutAccrual(input, tx);
    if (breakdown && breakdown.reservePesewas > 0 && this.reserveRelease) {
      await this.reserveRelease.recordHeldReserve(
        {
          merchantId: input.merchantId,
          customerPlanId: input.customerPlanId,
          model: input.model,
          amountPesewas: breakdown.reservePesewas,
          heldAt,
        },
        tx,
      );
    }
  }

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

      // Book the order_approved accrual atomically with activation. MODEL_CONFIG
      // decides whether anything books — bnpl/rent_to_own pay 100% here, hybrid/
      // layaway pay nothing on activation (the recorder returns null).
      await this.accrueAndTrack(
        tx,
        {
          customerPlanId: plan.id,
          merchantId: application.merchant_id,
          orderAmountPesewas: application.order_amount_pesewas,
          model: template.business_model as BusinessModel,
          trigger: 'order_approved',
        },
        now,
      );

      schedule.sort((a, b) => a.sequence_number - b.sequence_number);
      return { plan, schedule };
    });
  }

  /**
   * Records an out-of-band payment against one installment (admin override):
   * marks it paid, decrements the plan's outstanding balance, completes the
   * plan when nothing remains, and audits each change — all atomically.
   */
  async recordManualPayment(
    scheduleId: string,
    rawInput: unknown,
    actor: PlanActor,
    now: Date = new Date(),
  ): Promise<ManualPaymentResult> {
    const input = recordManualPaymentSchema.parse(rawInput);
    const nowIso = now.toISOString();
    const providerReference = input.provider_reference ?? 'manual';

    return runInTransaction(this.db, async (tx) => {
      const installment = (
        await tx.select().from(sched).where(eq(sched.id, scheduleId)).for('update').limit(1)
      )[0];
      if (!installment) throw new ScheduleNotFoundError(scheduleId);

      const from = installment.status as ScheduleStatus;
      if (from === 'paid' || SCHEDULE_TERMINAL_STATES.has(from)) {
        throw new InstallmentNotPayableError(scheduleId, from);
      }

      return this.finalisePaidInstallment(tx, installment, from, 'schedule.manual_payment', actor, {
        nowIso,
        providerReference,
        reason: input.reason,
      });
    });
  }

  /**
   * Settles an installment that Paystack confirmed as charged. Only valid from
   * `processing` (the state machine's charge_succeeded transition) — replays
   * land here as an illegal transition, which the caller treats idempotently.
   */
  async recordChargeSuccess(
    scheduleId: string,
    opts: { providerReference: string },
    actor: PlanActor,
    now: Date = new Date(),
  ): Promise<ManualPaymentResult> {
    const nowIso = now.toISOString();
    return runInTransaction(this.db, async (tx) => {
      const installment = (
        await tx.select().from(sched).where(eq(sched.id, scheduleId)).for('update').limit(1)
      )[0];
      if (!installment) throw new ScheduleNotFoundError(scheduleId);

      const from = installment.status as ScheduleStatus;
      nextScheduleStatus(from, 'charge_succeeded'); // validates processing → paid
      return this.finalisePaidInstallment(
        tx,
        installment,
        from,
        'schedule.charge_succeeded',
        actor,
        {
          nowIso,
          providerReference: opts.providerReference,
        },
      );
    });
  }

  /** Loads one installment row (throws if it doesn't exist). */
  async getInstallment(scheduleId: string): Promise<InstallmentScheduleRow> {
    const row = (await this.db.select().from(sched).where(eq(sched.id, scheduleId)).limit(1))[0];
    if (!row) throw new ScheduleNotFoundError(scheduleId);
    return row;
  }

  /**
   * Reverses a paid installment: schedule → refunded, plan outstanding bumped
   * back up (un-completing it if the refund re-opens balance), and a
   * proportional ledger reversal of every accrual that has fired for the plan.
   * All atomic in one transaction.
   *
   * The state machine enforces the precondition (only `paid` may refund);
   * replays land on `refunded`, which is terminal, so a re-call throws
   * {@link ScheduleTerminalStateError}.
   */
  async refundInstallment(
    scheduleId: string,
    opts: { reason?: string } = {},
    actor: PlanActor,
    now: Date = new Date(),
  ): Promise<ManualPaymentResult> {
    const nowIso = now.toISOString();
    return runInTransaction(this.db, async (tx) => {
      const installment = (
        await tx.select().from(sched).where(eq(sched.id, scheduleId)).for('update').limit(1)
      )[0];
      if (!installment) throw new ScheduleNotFoundError(scheduleId);

      const from = installment.status as ScheduleStatus;
      nextScheduleStatus(from, 'refund_issued'); // only `paid` allowed; throws otherwise

      const plan = (
        await tx
          .select()
          .from(cp)
          .where(eq(cp.id, installment.customer_plan_id))
          .for('update')
          .limit(1)
      )[0];
      if (!plan) throw new CustomerPlanNotFoundError(installment.customer_plan_id);

      const refundAmount = installment.amount_paid_pesewas;

      const [updatedSchedule] = await tx
        .update(sched)
        .set({
          status: 'refunded',
          status_changed_at: nowIso,
          version: installment.version + 1,
        })
        .where(and(eq(sched.id, installment.id), eq(sched.version, installment.version)))
        .returning();
      if (!updatedSchedule) throw new ScheduleConcurrencyError(installment.id);

      // Re-open the plan if the refund pushes outstanding back above zero.
      // (Conceptually the order is no longer satisfied — the customer is owed
      // money back, so the plan can't remain in `completed`.)
      const newOutstanding = plan.outstanding_pesewas + refundAmount;
      const reopen = plan.status === 'completed' && newOutstanding > 0;
      const [updatedPlan] = await tx
        .update(cp)
        .set({
          outstanding_pesewas: newOutstanding,
          ...(reopen ? { status: 'active', completed_at: null } : {}),
        })
        .where(eq(cp.id, plan.id))
        .returning();
      if (!updatedPlan) throw new Error('customer_plans update returned no row');

      await this.audit.append(tx, {
        entityType: 'installment_schedule',
        entityId: installment.id,
        eventType: 'schedule.refund_issued',
        fromState: from,
        toState: 'refunded',
        actorId: actor.actorId,
        actorType: actor.actorType,
        reason: opts.reason,
        metadata: { refund_amount_pesewas: refundAmount },
      });
      if (reopen) {
        await this.audit.append(tx, {
          entityType: 'customer_plan',
          entityId: plan.id,
          eventType: 'customer_plan.reopened',
          fromState: 'completed',
          toState: 'active',
          actorId: actor.actorId,
          actorType: actor.actorType,
          reason: 'refund_issued',
        });
      }

      if (this.payoutRecorder && refundAmount > 0) {
        await this.payoutRecorder.reverseAccrualsForRefund(
          {
            customerPlanId: plan.id,
            scheduleId: installment.id,
            refundAmountPesewas: refundAmount,
            model: plan.business_model as BusinessModel,
          },
          tx,
        );
      }

      return { schedule: updatedSchedule, plan: updatedPlan };
    });
  }

  /**
   * Marks an installment paid and applies the plan-level effect (reduce
   * outstanding, complete when cleared) within the caller's transaction.
   * Shared by the manual-override and the charge-success paths.
   */
  private async finalisePaidInstallment(
    tx: TransactionalTx,
    installment: InstallmentScheduleRow,
    from: ScheduleStatus,
    eventType: string,
    actor: PlanActor,
    opts: { nowIso: string; providerReference: string; reason?: string },
  ): Promise<ManualPaymentResult> {
    const amountDue = installment.amount_due_pesewas;
    const settled = amountDue + installment.late_fee_pesewas;
    const [updatedSchedule] = await tx
      .update(sched)
      .set({
        status: 'paid',
        amount_paid_pesewas: settled,
        paid_at: opts.nowIso,
        status_changed_at: opts.nowIso,
        provider_reference: opts.providerReference,
        version: installment.version + 1,
      })
      .where(and(eq(sched.id, installment.id), eq(sched.version, installment.version)))
      .returning();
    if (!updatedSchedule) throw new ScheduleConcurrencyError(installment.id);

    const plan = (
      await tx
        .select()
        .from(cp)
        .where(eq(cp.id, installment.customer_plan_id))
        .for('update')
        .limit(1)
    )[0];
    if (!plan) throw new CustomerPlanNotFoundError(installment.customer_plan_id);

    const newOutstanding = Math.max(0, plan.outstanding_pesewas - amountDue);
    const completed = newOutstanding === 0 && plan.status === 'active';
    const [updatedPlan] = await tx
      .update(cp)
      .set({
        outstanding_pesewas: newOutstanding,
        ...(completed ? { status: 'completed', completed_at: opts.nowIso } : {}),
      })
      .where(eq(cp.id, plan.id))
      .returning();

    await this.audit.append(tx, {
      entityType: 'installment_schedule',
      entityId: installment.id,
      eventType,
      fromState: from,
      toState: 'paid',
      actorId: actor.actorId,
      actorType: actor.actorType,
      reason: opts.reason,
      metadata: { amount_pesewas: settled, provider_reference: opts.providerReference },
    });
    if (completed) {
      await this.audit.append(tx, {
        entityType: 'customer_plan',
        entityId: plan.id,
        eventType: 'customer_plan.completed',
        fromState: 'active',
        toState: 'completed',
        actorId: actor.actorId,
        actorType: actor.actorType,
      });
    }

    // Payout accruals — MODEL_CONFIG decides whether each trigger books anything;
    // the recorder returns null on unmapped triggers, so it's safe to attempt
    // both. Stays in the caller's tx so the accrual lives or dies with the row.
    if (this.payoutRecorder) {
      const base = {
        customerPlanId: plan.id,
        merchantId: plan.merchant_id,
        orderAmountPesewas: plan.order_amount_pesewas,
        model: plan.business_model as BusinessModel,
      };
      const heldAt = new Date(opts.nowIso);
      // Hybrid plans accrue 40% when the down-payment row (sequence 1) settles.
      if (installment.sequence_number === 1) {
        await this.accrueAndTrack(tx, { ...base, trigger: 'down_payment_received' }, heldAt);
      }
      // Layaway 100% / hybrid 60% accrue at completion.
      if (completed) {
        await this.accrueAndTrack(tx, { ...base, trigger: 'plan_completed' }, heldAt);
        // Both buffer-policy models start their release clock at completion.
        await this.reserveRelease?.markPlanCompleted(plan.id, heldAt, tx);
      }
    }

    return { schedule: updatedSchedule, plan: updatedPlan! };
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

  /** Assembles a customer-facing statement (plan summary + installment lines). */
  async getStatement(planId: string, now: Date = new Date()): Promise<Statement> {
    const plan = await this.get(planId);
    const schedule = await this.getSchedule(planId);
    const { customerName, merchantName } = await this.loadParties(plan);
    return buildStatement({ plan, schedule, customerName, merchantName, now });
  }

  /** Builds a payment receipt for a paid installment. */
  async getReceipt(scheduleId: string, now: Date = new Date()): Promise<Receipt> {
    const installment = await this.getInstallment(scheduleId);
    if (installment.status !== 'paid') {
      throw new ReceiptNotAvailableError(scheduleId, installment.status);
    }
    const plan = await this.get(installment.customer_plan_id);
    const { customerName, merchantName } = await this.loadParties(plan);
    return buildReceipt({ plan, installment, customerName, merchantName, now });
  }

  /** Resolves the customer + merchant display names for a plan. */
  private async loadParties(
    plan: CustomerPlan,
  ): Promise<{ customerName: string; merchantName: string | null }> {
    const cust = (
      await this.db
        .select({ first: customers.first_name, last: customers.last_name })
        .from(customers)
        .where(eq(customers.id, plan.customer_id))
        .limit(1)
    )[0];
    const merch = (
      await this.db
        .select({ name: merchants.business_name })
        .from(merchants)
        .where(eq(merchants.id, plan.merchant_id))
        .limit(1)
    )[0];
    return {
      customerName: cust ? `${cust.first} ${cust.last}` : 'Unknown',
      merchantName: merch?.name ?? null,
    };
  }
}
