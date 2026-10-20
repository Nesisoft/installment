import { and, desc, eq, gt, sql } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import { AuditLogger, type AuditActorType } from '../audit/audit-logger.service';
import { LedgerService, type LedgerEntryInput } from '../../shared/ledger/ledger.service';
import { runInTransaction, type TransactionalTx } from '../../shared/event-bus/transaction';
import { SETTLEMENT_CASH_REF, type SettlementService } from '../settlements/settlement.service';
import type { PlanCashLedger } from '../schedules/plan-cash-ledger';
import {
  IGNORED_PAYOUT_REVERSALS_SQL,
  OVERSIZED_DEFAULTS_SQL,
  STRANDED_COLLECTIONS_CASES_SQL,
  UNRESOLVED_ATTEMPTS_SQL,
} from './queries';

const plansTbl = schema.customer_plans;
const held = schema.held_reserves;
const cases = schema.collections_cases;
const actions = schema.collections_actions;

/** The operator a repair is recorded against — a real staff account, never a system actor. */
export interface RepairActor {
  actorId: string;
  actorType: AuditActorType;
}

export interface OversizedDefault {
  customerPlanId: string;
  merchantId: string;
  businessModel: string;
  defaultedAt: string;
  /** Receivable open on the plan when it defaulted: what had been fronted and not repaid. */
  frontedOpenPesewas: number;
  writtenOffPesewas: number;
  shouldWriteOffPesewas: number;
  fromReservePesewas: number;
  shouldFromReservePesewas: number;
  fromMerchantPesewas: number;
  shouldFromMerchantPesewas: number;
  fromPoolPesewas: number;
  shouldFromPoolPesewas: number;
  /** What the compensating transaction gives back to each account. */
  correction: { receivable: number; reserve: number; merchant: number; pool: number };
}

export interface IgnoredPayoutReversal {
  payoutId: string;
  reference: string;
  merchantId: string;
  amountPesewas: number;
  settledAt: string | null;
  reversedAt: string;
  gatewayResponse: string | null;
}

export interface StrandedCollectionsCase {
  caseId: string;
  customerPlanId: string;
  scheduleId: string;
  resolution: string | null;
  closedAt: string;
  sequenceNumber: number;
  dueDate: string;
  amountDuePesewas: number;
  amountPaidPesewas: number;
  lateFeePesewas: number;
  customerName: string;
  customerPhone: string;
  closedBy: string | null;
  closeNote: string | null;
}

export interface UnresolvedAttempts {
  status: string;
  attempts: number;
  oldest: string;
}

export interface MoneyRepairReport {
  oversizedDefaults: OversizedDefault[];
  ignoredPayoutReversals: IgnoredPayoutReversal[];
  strandedCollectionsCases: StrandedCollectionsCase[];
  unresolvedPaymentAttempts: UnresolvedAttempts[];
}

/** A repair that would leave the books disagreeing with themselves. Nothing was written. */
export class MoneyRepairError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyRepairError';
  }
}

type Row = Record<string, unknown>;
type Executor = Pick<Database, 'execute'>;

const num = (v: unknown): number => Number(v ?? 0);
const str = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : str(v));

function toOversizedDefault(r: Row): OversizedDefault {
  const d: Omit<OversizedDefault, 'correction'> = {
    customerPlanId: str(r.customer_plan_id),
    merchantId: str(r.merchant_id),
    businessModel: str(r.business_model),
    defaultedAt: str(r.defaulted_at),
    frontedOpenPesewas: num(r.fronted_open),
    writtenOffPesewas: num(r.written_off),
    shouldWriteOffPesewas: num(r.should_write_off),
    fromReservePesewas: num(r.from_reserve),
    shouldFromReservePesewas: num(r.should_from_reserve),
    fromMerchantPesewas: num(r.from_merchant),
    shouldFromMerchantPesewas: num(r.should_from_merchant),
    fromPoolPesewas: num(r.from_pool),
    shouldFromPoolPesewas: num(r.should_from_pool),
  };
  return {
    ...d,
    correction: {
      receivable: d.writtenOffPesewas - d.shouldWriteOffPesewas,
      reserve: d.fromReservePesewas - d.shouldFromReservePesewas,
      merchant: d.fromMerchantPesewas - d.shouldFromMerchantPesewas,
      pool: d.fromPoolPesewas - d.shouldFromPoolPesewas,
    },
  };
}

function toIgnoredReversal(r: Row): IgnoredPayoutReversal {
  return {
    payoutId: str(r.payout_id),
    reference: str(r.reference),
    merchantId: str(r.merchant_id),
    amountPesewas: num(r.amount_pesewas),
    settledAt: strOrNull(r.settled_at),
    reversedAt: str(r.reversed_at),
    gatewayResponse: strOrNull(r.gateway_response),
  };
}

function toStrandedCase(r: Row): StrandedCollectionsCase {
  return {
    caseId: str(r.case_id),
    customerPlanId: str(r.customer_plan_id),
    scheduleId: str(r.schedule_id),
    resolution: strOrNull(r.resolution),
    closedAt: str(r.closed_at),
    sequenceNumber: num(r.sequence_number),
    dueDate: str(r.due_date),
    amountDuePesewas: num(r.amount_due_pesewas),
    amountPaidPesewas: num(r.amount_paid_pesewas),
    lateFeePesewas: num(r.late_fee_pesewas),
    customerName: str(r.customer_name),
    customerPhone: str(r.customer_phone),
    closedBy: strOrNull(r.closed_by),
    closeNote: strOrNull(r.close_note),
  };
}

/**
 * Finds, and on request corrects, what four fixed bugs left wrong in the data.
 *
 * Reading is the default and changes nothing. Each correction goes through the
 * code that owns the thing being corrected — `LedgerService` for entries (it
 * refuses an unbalanced transaction), `SettlementService.confirmPayout` for a
 * reversal — and is recorded in the audit log against a named operator. Each is
 * idempotent: a correction already applied takes the row off the report, and
 * applying it again does nothing.
 *
 * The ledger is append-only, so nothing here edits an entry. A wrong posting is
 * answered by a compensating one, and both stay visible.
 */
export class MoneyRepairsService {
  constructor(
    private readonly db: Database,
    private readonly ledger: LedgerService,
    private readonly audit: AuditLogger,
    private readonly settlement: Pick<SettlementService, 'confirmPayout'>,
    private readonly cashLedger: Pick<PlanCashLedger, 'sweepFloatToReceivable'>,
  ) {}

  async report(): Promise<MoneyRepairReport> {
    const [oversizedDefaults, ignoredPayoutReversals, strandedCollectionsCases, attempts] =
      await Promise.all([
        this.findOversizedDefaults(),
        this.findIgnoredPayoutReversals(),
        this.findStrandedCollectionsCases(),
        this.rows(this.db, UNRESOLVED_ATTEMPTS_SQL),
      ]);
    return {
      oversizedDefaults,
      ignoredPayoutReversals,
      strandedCollectionsCases,
      unresolvedPaymentAttempts: attempts.map((r) => ({
        status: str(r.status),
        attempts: num(r.attempts),
        oldest: str(r.oldest),
      })),
    };
  }

  async findOversizedDefaults(): Promise<OversizedDefault[]> {
    return (await this.rows(this.db, OVERSIZED_DEFAULTS_SQL)).map(toOversizedDefault);
  }

  async findIgnoredPayoutReversals(): Promise<IgnoredPayoutReversal[]> {
    return (await this.rows(this.db, IGNORED_PAYOUT_REVERSALS_SQL)).map(toIgnoredReversal);
  }

  async findStrandedCollectionsCases(): Promise<StrandedCollectionsCase[]> {
    return (await this.rows(this.db, STRANDED_COLLECTIONS_CASES_SQL)).map(toStrandedCase);
  }

  /**
   * Resizes one oversized default to what the platform had fronted.
   *
   * Posts `compensate:default:{plan}`: a receivable DEBIT for the excess
   * written off, matched by credits giving back what each absorber paid beyond
   * its share — the reserve, then the merchant's payable or the default pool.
   * The reserve given back is also returned to its `held_reserves` rows, with
   * the default's release clock set, so the release sweep pays it to the
   * merchant on the model's buffer like any surviving reserve.
   *
   * Cash the customer paid after the default found nothing owed — the oversized
   * write-off had retired it all — and was held as float. The correction
   * reopens that receivable, so the float is swept onto it, as an accrual's
   * sweep would have done had the default been sized right.
   *
   * Returns null when the plan has nothing to correct, including when it has
   * already been corrected.
   */
  async correctOversizedDefault(
    customerPlanId: string,
    actor: RepairActor,
  ): Promise<OversizedDefault | null> {
    return runInTransaction(this.db, async (tx) => {
      // Serialises with anything else touching the plan, and re-reads the
      // figures under that lock rather than trusting a report taken earlier.
      const plan = (
        await tx
          .select()
          .from(plansTbl)
          .where(eq(plansTbl.id, customerPlanId))
          .for('update')
          .limit(1)
      )[0];
      if (!plan) return null;
      const found = (
        await this.rowsFor(tx, OVERSIZED_DEFAULTS_SQL, 'customer_plan_id', plan.id)
      )[0];
      if (!found) return null;
      const d = toOversizedDefault(found);
      const c = d.correction;
      if (c.receivable <= 0) return null;
      if (c.reserve < 0 || c.merchant < 0 || c.pool < 0) {
        throw new MoneyRepairError(
          `Plan ${plan.id}: the default would need more taken, not given back (${JSON.stringify(c)}). Nothing was written.`,
        );
      }

      const transactionId = `compensate:default:${plan.id}`;
      const metadata = {
        reason: 'default_correction',
        customer_plan_id: plan.id,
        model: d.businessModel,
        fronted_open_pesewas: d.frontedOpenPesewas,
      };
      const postings: LedgerEntryInput[] = [
        {
          transactionId,
          accountType: 'receivable',
          accountRef: plan.id,
          direction: 'debit',
          amountPesewas: c.receivable,
          description: 'Default write-off resized to what was fronted',
          metadata,
        },
        {
          transactionId,
          accountType: 'reserve_held',
          accountRef: plan.id,
          direction: 'credit',
          amountPesewas: c.reserve,
          description: 'Reserve drawn beyond the fronted loss, restored',
          metadata,
        },
        {
          transactionId,
          accountType: 'merchant_payable',
          accountRef: plan.merchant_id,
          direction: 'credit',
          amountPesewas: c.merchant,
          description: 'Default claw-back beyond the fronted loss, returned',
          metadata,
        },
        {
          transactionId,
          accountType: 'default_pool',
          accountRef: SETTLEMENT_CASH_REF,
          direction: 'credit',
          amountPesewas: c.pool,
          description: 'Default pool charge beyond the fronted loss, returned',
          metadata,
        },
      ];
      // The ledger refuses zero-amount rows; a model without a merchant or
      // pool share simply has nothing to give back there.
      await this.ledger.record(
        postings.filter((e) => e.amountPesewas > 0),
        tx,
      );

      await this.restoreReserveRows(tx, plan.id, c.reserve, plan.defaulted_at);
      await this.cashLedger.sweepFloatToReceivable(plan.id, 'compensate-default', tx);

      await this.audit.append(tx, {
        entityType: 'customer_plan',
        entityId: plan.id,
        eventType: 'customer_plan.default_corrected',
        actorId: actor.actorId,
        actorType: actor.actorType,
        reason: 'default sized beyond what was fronted (#114)',
        metadata: {
          written_off_pesewas: d.writtenOffPesewas,
          should_write_off_pesewas: d.shouldWriteOffPesewas,
          returned_to_reserve_pesewas: c.reserve,
          returned_to_merchant_pesewas: c.merchant,
          returned_to_pool_pesewas: c.pool,
        },
      });
      return d;
    });
  }

  /**
   * Gives `amount` of consumed reserve back to the plan's `held_reserves` rows.
   *
   * The consumption closed a row it exhausted (`fully_released_at`), and a
   * closed row never received the default's release clock. A row with reserve
   * back in it is reopened and given that clock, or the sweep would never pay
   * the restored reserve out. Bookkeeping that cannot absorb the whole amount
   * means it disagrees with the ledger, and the transaction is refused.
   */
  private async restoreReserveRows(
    tx: TransactionalTx,
    customerPlanId: string,
    amount: number,
    defaultedAt: string | null,
  ): Promise<void> {
    if (amount <= 0) return;
    const rows = await tx
      .select()
      .from(held)
      .where(
        and(eq(held.customer_plan_id, customerPlanId), gt(held.consumed_for_default_pesewas, 0)),
      )
      .orderBy(desc(held.held_at), desc(held.id))
      .for('update');
    let remaining = amount;
    for (const row of rows) {
      if (remaining <= 0) break;
      const give = Math.min(row.consumed_for_default_pesewas, remaining);
      const consumed = row.consumed_for_default_pesewas - give;
      const exhausted = row.released_amount_pesewas + consumed >= row.amount_pesewas;
      await tx
        .update(held)
        .set({
          consumed_for_default_pesewas: consumed,
          fully_released_at: exhausted ? row.fully_released_at : null,
          plan_defaulted_at: row.plan_defaulted_at ?? defaultedAt,
        })
        .where(eq(held.id, row.id));
      remaining -= give;
    }
    if (remaining > 0) {
      throw new MoneyRepairError(
        `Plan ${customerPlanId}: held_reserves records ${amount - remaining} of reserve consumed by the default, the ledger ${amount}. Nothing was written.`,
      );
    }
  }

  /**
   * Applies one ignored `transfer.reversed` through the fixed confirmation path:
   * the payout becomes `reversed` and the merchant is owed the amount again,
   * exactly as the webhook now does. Returns null when the payout is no longer
   * listed — already reversed, or never settled — and when another call applied
   * it first: `confirmPayout` decides under its row lock, and only the call that
   * changed the payout records having done so.
   */
  async applyIgnoredPayoutReversal(
    reference: string,
    actor: RepairActor,
  ): Promise<IgnoredPayoutReversal | null> {
    const found = (
      await this.rowsFor(this.db, IGNORED_PAYOUT_REVERSALS_SQL, 'reference', reference)
    )[0];
    if (!found) return null;
    const r = toIgnoredReversal(found);
    const applied = await this.settlement.confirmPayout(reference, 'reversed', {
      error: r.gatewayResponse ?? 'transfer.reversed',
    });
    if (!applied) return null;
    await this.audit.append(this.db, {
      entityType: 'payout',
      entityId: r.payoutId,
      eventType: 'payout.reversal_applied',
      fromState: 'settled',
      toState: 'reversed',
      actorId: actor.actorId,
      actorType: actor.actorType,
      reason: 'transfer.reversed ignored on a settled payout (#111)',
      metadata: { reference: r.reference, reversed_at: r.reversedAt },
    });
    return r;
  }

  /**
   * Reopens a collections case closed over an instalment nobody settled, so
   * the debt is worked again — or closed properly, as waived, from the admin
   * console.
   *
   * It reopens at the start of the ladder, `soft_reminder` from today.
   * Escalation reads `opened_at`, not the stage: a case reopened with its
   * original date resumed at whatever stage its age warranted, so one opened
   * ninety days ago went to `write_off` on the next sweep and defaulted the
   * whole plan, before anyone could waive it. The customer was told nothing
   * while it was closed; starting the reminders again from the first is also
   * the fair thing. The original date and stage go in the audit record.
   */
  async reopenStrandedCase(
    caseId: string,
    reason: string,
    actor: RepairActor,
  ): Promise<StrandedCollectionsCase> {
    if (!reason.trim()) throw new MoneyRepairError('A reason is required to reopen a case.');
    return runInTransaction(this.db, async (tx) => {
      const c = (
        await tx.select().from(cases).where(eq(cases.id, caseId)).for('update').limit(1)
      )[0];
      if (!c) throw new MoneyRepairError(`Collections case ${caseId} not found.`);
      const found = (await this.rowsFor(tx, STRANDED_COLLECTIONS_CASES_SQL, 'case_id', caseId))[0];
      if (!found) {
        throw new MoneyRepairError(
          `Collections case ${caseId} is not stranded: it is open, its instalment has left in_collections, or another case is open on it.`,
        );
      }
      const stranded = toStrandedCase(found);
      const nowIso = new Date().toISOString();
      await tx
        .update(cases)
        .set({
          closed_at: null,
          resolution: null,
          current_stage: 'soft_reminder',
          opened_at: nowIso,
          stage_entered_at: nowIso,
          updated_at: nowIso,
        })
        .where(eq(cases.id, caseId));
      await tx.insert(actions).values({
        case_id: caseId,
        action_type: 'note_added',
        outcome: 'reopened',
        notes: reason.trim(),
        performed_by: actor.actorId,
        metadata: { repair: true, previous_resolution: c.resolution },
      });
      await this.audit.append(tx, {
        entityType: 'collections_case',
        entityId: caseId,
        eventType: 'collections_case.reopened',
        fromState: c.resolution,
        toState: 'soft_reminder',
        actorId: actor.actorId,
        actorType: actor.actorType,
        reason: reason.trim(),
        metadata: {
          repair: '#110',
          schedule_id: c.schedule_id,
          previous_stage: c.current_stage,
          previously_opened_at: c.opened_at,
        },
      });
      return stranded;
    });
  }

  private async rows(exec: Executor, query: string): Promise<Row[]> {
    return (await exec.execute(sql.raw(query))).rows as Row[];
  }

  /** One query's rows for one key — the same query, so the filter cannot drift from the report. */
  private async rowsFor(
    exec: Executor,
    query: string,
    column: string,
    value: string,
  ): Promise<Row[]> {
    const result = await exec.execute(
      sql`SELECT * FROM (${sql.raw(query)}) q WHERE q.${sql.identifier(column)}::text = ${value}`,
    );
    return result.rows as Row[];
  }
}
