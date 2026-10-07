import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, schema } from '@installment/db';
import { AuditLogger } from '../audit/audit-logger.service';
import { SYSTEM_ACTORS } from '../../shared/constants/system-actors';
import { MerchantsService } from '../merchants/merchants.service';
import { CustomersService } from '../customers/customers.service';
import { MockGhanaCardVerifier } from '../customers/ghana-card-verifier';
import { PlanTemplatesService } from '../plans/plan-templates.service';
import { ApplicationsService } from '../applications/applications.service';
import { CustomerPlansService } from '../schedules/customer-plans.service';
import { LedgerService } from '../../shared/ledger/ledger.service';
import { SettlementService } from '../settlements/settlement.service';
import {
  ReconciliationService,
  type RefundVerifyClient,
} from '../settlements/reconciliation.service';
import { RefundService, type RefundClient } from './refund.service';

const RUN_DB = Boolean(process.env.DATABASE_URL);

/** Always accepts, so `disburse` reaches its post-call write. */
const acceptingClient: RefundClient = {
  async refund() {
    return { data: { id: `rf_${randomUUID()}`, status: 'processed' } };
  },
};

/** Never consulted in these cases, but the reconciler needs one wired. */
const verifier: RefundVerifyClient = {
  async verifyRefund() {
    return { data: { status: 'processed' } };
  },
};

const noTransfers = {
  async initiateTransfer() {
    throw new Error('not used');
  },
};

/**
 * The refund queues, and the gap between them.
 *
 * `findUnsent` selects `status = 'initiated' AND submitted_at IS NULL`.
 * `reconcilePendingRefunds` selects `status IN ('pending_confirmation', 'unknown')`.
 *
 * `claimForSubmission` stamps `submitted_at` while leaving the status at
 * `initiated`, and everything after the provider call in `disburse` —
 * `confirmRefund`, `markUnknown`, the pending write — runs outside any try.
 * Those writes take a FOR UPDATE lock and post to the ledger, so they can
 * throw. A refund that throws there is left `initiated` with `submitted_at`
 * set: selected by neither query. Submitted to Paystack, invisible to the
 * sweep that would retry it and to the reconciler that would resolve it.
 */
describe.skipIf(!RUN_DB)('refund queue coverage (integration)', () => {
  const { db, pool } = createTestDb();
  const audit = new AuditLogger();
  const ledger = new LedgerService(db);
  const merchants = new MerchantsService(db, audit);
  const customers = new CustomersService(db, audit, new MockGhanaCardVerifier());
  const planTemplates = new PlanTemplatesService(db, audit);
  const apps = new ApplicationsService(db, audit);
  const plans = new CustomerPlansService(db, audit);
  const ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  let templateId: string;
  let merchantId: string;
  let customerId: string;

  beforeAll(async () => {
    const suffix = randomUUID();
    merchantId = (
      await merchants.create(
        {
          business_name: `RQ ${suffix}`,
          legal_name: `RQ Ltd ${suffix}`,
          email: `rq+${suffix}@x.gh`,
          phone: '+233244000000',
        },
        ACTOR,
      )
    ).id;
    customerId = (
      await customers.register(
        {
          first_name: 'Refund',
          last_name: 'Queue',
          email: `rq+${suffix}@x.gh`,
          phone: `024${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
        },
        ACTOR,
      )
    ).id;
    templateId = (
      await planTemplates.create(
        {
          name: `BNPL-rq ${suffix}`,
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

  /** A plan with its schedule, to hang refund rows off. */
  async function freshSchedule(): Promise<{ planId: string; scheduleId: string }> {
    const app = await apps.submit(
      {
        customer_id: customerId,
        merchant_id: merchantId,
        plan_template_id: templateId,
        order_reference: `ORD-${randomUUID()}`,
        order_amount_pesewas: 100_000,
        merchant_category: 'electronics',
      },
      ACTOR,
    );
    await apps.recordDecision(app.id, { outcome: 'approved' }, ACTOR);
    const { plan, schedule } = await plans.activateFromApplication(app.id, ACTOR);
    return { planId: plan.id, scheduleId: schedule[0]!.id };
  }

  async function makeRefund(opts: { submittedAt?: Date } = {}): Promise<string> {
    const { planId, scheduleId } = await freshSchedule();
    const reference = `refund:${randomUUID()}`;
    await db.insert(schema.refunds).values({
      customer_plan_id: planId,
      schedule_id: scheduleId,
      amount_pesewas: 25_000,
      reference,
      method: 'paystack',
      provider_transaction_reference: `ps_${randomUUID()}`,
      status: 'initiated',
      ...(opts.submittedAt ? { submitted_at: opts.submittedAt.toISOString() } : {}),
    });
    return reference;
  }

  it('a refund claimed but never resolved is picked up by the reconciler', async () => {
    // Exactly the state a crash between claim and confirm leaves behind.
    const reference = await makeRefund({ submittedAt: new Date() });

    const refunds = new RefundService(db, ledger, audit, acceptingClient);
    const settlement = new SettlementService(db, ledger, audit, noTransfers);
    const reconciler = new ReconciliationService(
      db,
      settlement,
      {
        async verifyTransfer() {
          throw new Error('not used');
        },
      },
      refunds,
      verifier,
    );

    // The disbursement sweep will not touch it — submitted_at is set.
    const sweep = await refunds.runSweep(500);
    expect(sweep.results.some((r) => r.reference === reference)).toBe(false);

    // So the reconciler has to, or nobody ever will.
    const reconciled = await reconciler.reconcilePendingRefunds({ limit: 500 });
    const ours = reconciled.results.find((r) => r.reference === reference);
    expect(ours).toBeDefined();
    // No provider refund id was ever recorded, so it cannot be verified and
    // must not be silently re-sent. `unresolved` surfaces it for a human,
    // which is the honest outcome and what the refund cron alerts on.
    expect(ours!.outcome).toBe('unresolved');
  });

  it('one refund failing to record does not end the sweep', async () => {
    const first = await makeRefund();
    const second = await makeRefund();

    const refunds = new RefundService(db, ledger, audit, acceptingClient);
    const real = refunds.confirmRefund.bind(refunds);
    const spy = vi
      .spyOn(refunds, 'confirmRefund')
      .mockImplementation(async (reference, outcome, opts) => {
        if (reference === first) throw new Error('lock timeout on refunds row');
        return real(reference, outcome, opts);
      });

    let summary;
    try {
      summary = await refunds.runSweep(500);
    } finally {
      spy.mockRestore();
    }

    // The one behind it still went out.
    const ok = summary.results.find((r) => r.reference === second);
    expect(ok).toBeDefined();
    expect(ok!.outcome).toBe('succeeded');

    // And the failure is reported rather than thrown away.
    const bad = summary.results.find((r) => r.reference === first);
    expect(bad).toBeDefined();
    expect(bad!.outcome).toBe('unknown');
    expect(bad!.reason).toContain('lock timeout');

    const [row] = await db
      .select()
      .from(schema.refunds)
      .where(eq(schema.refunds.reference, second));
    expect(row!.status).toBe('succeeded');
  });
});
