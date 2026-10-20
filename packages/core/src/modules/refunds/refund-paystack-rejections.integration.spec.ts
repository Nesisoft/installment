import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

/**
 * What Paystack answers when it will not create a refund, and what this code
 * did with it.
 *
 * Captured from Paystack test mode with the repo's own client (2026-10-20).
 * Every refusal is an HTTP 400 the client throws, and `disburse` parked every
 * throw as `unknown` with no provider refund id — a row the reconciler can
 * never verify, so each one waited for a person indefinitely:
 *
 *   - `refund_amount_exceeds_transaction_amount` / `transaction_not_found`
 *     (`type: validation_error`): Paystack refused; no refund was created.
 *   - `transaction_reversed`, "A refund already exist for this transaction":
 *     the body names the existing refund in `data.existing_refunds`.
 *
 * A refund left `unknown` with no id — a lost response — can be found too:
 * `GET /refund?transaction=<id>` lists a charge's refunds, but only by
 * Paystack's NUMERIC transaction id. By reference it answers `status: true`
 * with an empty list, which would read as "no refund exists" and invite a
 * second one.
 */
describe.skipIf(!RUN_DB)('refunds Paystack refuses (integration)', () => {
  const { db, pool } = createTestDb();
  const audit = new AuditLogger();
  const ledger = new LedgerService(db);
  const merchants = new MerchantsService(db, audit);
  const customers = new CustomersService(db, audit, new MockGhanaCardVerifier());
  const planTemplates = new PlanTemplatesService(db, audit);
  const apps = new ApplicationsService(db, audit);
  const plans = new CustomerPlansService(db, audit);
  const ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };
  const AMOUNT = 25_000;

  let templateId: string;
  let merchantId: string;
  let customerId: string;

  beforeAll(async () => {
    const suffix = randomUUID();
    merchantId = (
      await merchants.create(
        {
          business_name: `RR ${suffix}`,
          legal_name: `RR Ltd ${suffix}`,
          email: `rr+${suffix}@x.gh`,
          phone: '+233244000000',
        },
        ACTOR,
      )
    ).id;
    customerId = (
      await customers.register(
        {
          first_name: 'Refund',
          last_name: 'Refused',
          email: `rr+${suffix}@x.gh`,
          phone: `024${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
        },
        ACTOR,
      )
    ).id;
    templateId = (
      await planTemplates.create(
        {
          name: `BNPL-rr ${suffix}`,
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

  async function makeRefund(
    opts: { status?: 'initiated' | 'unknown'; paystackRefundId?: string } = {},
  ): Promise<string> {
    const { planId, scheduleId } = await freshSchedule();
    const reference = `refund:${randomUUID()}`;
    await db.insert(schema.refunds).values({
      customer_plan_id: planId,
      schedule_id: scheduleId,
      amount_pesewas: AMOUNT,
      reference,
      method: 'paystack',
      provider_transaction_reference: `ps_${randomUUID()}`,
      status: opts.status ?? 'initiated',
      ...(opts.status === 'unknown' ? { submitted_at: new Date().toISOString() } : {}),
      ...(opts.paystackRefundId ? { paystack_refund_id: opts.paystackRefundId } : {}),
    });
    return reference;
  }

  async function row(reference: string) {
    return (
      await db.select().from(schema.refunds).where(eq(schema.refunds.reference, reference))
    )[0]!;
  }

  /** The error the client throws for a 400, carrying the body Paystack sent. */
  function paystack400(body: Record<string, unknown>): Error {
    return Object.assign(new Error(String(body.message)), {
      name: 'PaystackError',
      status: 400,
      cause: { status: false, ...body },
    });
  }

  function throwing(err: Error): RefundClient {
    return {
      async refund() {
        throw err;
      },
    };
  }

  /** A provider refund id no other test row will hold. */
  const freshId = () => String(Math.floor(10_000_000 + Math.random() * 89_999_999));

  // ------------------------------------------------------------ disburse

  it("records a refund Paystack refuses as invalid as failed, with Paystack's reason", async () => {
    const reference = await makeRefund();
    const refunds = new RefundService(
      db,
      ledger,
      audit,
      throwing(
        paystack400({
          message: 'Refund amount exceeds transaction amount',
          type: 'validation_error',
          code: 'refund_amount_exceeds_transaction_amount',
        }),
      ),
    );

    const result = await refunds.disburse(reference);

    expect(result.outcome).toBe('failed');
    const r = await row(reference);
    expect(r.status).toBe('failed');
    expect(r.last_error).toBe('Refund amount exceeds transaction amount');
  });

  it('records a refund for a charge Paystack has no record of as failed', async () => {
    const reference = await makeRefund();
    const refunds = new RefundService(
      db,
      ledger,
      audit,
      throwing(
        paystack400({
          message: 'Transaction not found',
          type: 'validation_error',
          code: 'transaction_not_found',
        }),
      ),
    );
    expect((await refunds.disburse(reference)).outcome).toBe('failed');
    expect((await row(reference)).last_error).toBe('Transaction not found');
  });

  function alreadyExists(existing: Array<{ id: string; amount: number; status: string }>) {
    return paystack400({
      message: 'A refund already exist for this transaction',
      type: 'api_error',
      code: 'transaction_reversed',
      data: { existing_refunds: existing },
    });
  }

  it('takes on the refund Paystack says already exists, instead of stranding it', async () => {
    const reference = await makeRefund();
    const id = freshId();
    const refunds = new RefundService(
      db,
      ledger,
      audit,
      throwing(alreadyExists([{ id, amount: AMOUNT, status: 'pending' }])),
    );

    const result = await refunds.disburse(reference);

    expect(result.outcome).toBe('pending_confirmation');
    const r = await row(reference);
    expect(r.status).toBe('pending_confirmation');
    // With the id, the reconciler can follow it to the end on its own.
    expect(r.paystack_refund_id).toBe(id);
  });

  it('does not take on an existing refund of a different amount', async () => {
    const reference = await makeRefund();
    const refunds = new RefundService(
      db,
      ledger,
      audit,
      throwing(alreadyExists([{ id: freshId(), amount: AMOUNT - 1, status: 'pending' }])),
    );
    expect((await refunds.disburse(reference)).outcome).toBe('unknown');
    expect((await row(reference)).paystack_refund_id).toBeNull();
  });

  it('does not take on a refund another of our rows already accounts for', async () => {
    const id = freshId();
    await makeRefund({ paystackRefundId: id });
    const reference = await makeRefund();
    const refunds = new RefundService(
      db,
      ledger,
      audit,
      throwing(alreadyExists([{ id, amount: AMOUNT, status: 'pending' }])),
    );
    expect((await refunds.disburse(reference)).outcome).toBe('unknown');
  });

  it('still parks a refund unknown when the call itself failed', async () => {
    const reference = await makeRefund();
    const refunds = new RefundService(db, ledger, audit, throwing(new Error('socket hang up')));
    expect((await refunds.disburse(reference)).outcome).toBe('unknown');
  });

  // ------------------------------------------------------------ reconcile

  function reconciler(verifier: RefundVerifyClient) {
    const refunds = new RefundService(db, ledger, audit, throwing(new Error('not used')));
    const settlement = new SettlementService(db, ledger, audit, {
      async initiateTransfer() {
        throw new Error('not used');
      },
    });
    return new ReconciliationService(
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
  }

  it("recovers a lost refund id from Paystack, by the charge's numeric id", async () => {
    const reference = await makeRefund({ status: 'unknown' });
    const providerRef = (await row(reference)).provider_transaction_reference!;
    const id = freshId();
    const looked: unknown[] = [];

    const verifier: RefundVerifyClient = {
      async verifyRefund(refundId) {
        expect(refundId).toBe(id);
        return { data: { status: 'processed' } };
      },
      async verifyTransaction(ref) {
        expect(ref).toBe(providerRef);
        return { data: { id: 6675930705 } };
      },
      async listRefundsForTransaction(transactionId) {
        looked.push(transactionId);
        return { data: [{ id, amount: AMOUNT, status: 'processed' }] };
      },
    };

    const summary = await reconciler(verifier).reconcilePendingRefunds({ limit: 500 });
    const ours = summary.results.find((r) => r.reference === reference);

    // Never by reference: Paystack answers that with an empty list.
    expect(looked).toEqual(['6675930705']);
    expect(ours?.outcome).toBe('settled');
    const r = await row(reference);
    expect(r.status).toBe('succeeded');
    expect(r.paystack_refund_id).toBe(id);
  });

  it('leaves it unresolved, and says so, when Paystack holds no refund for the charge', async () => {
    const reference = await makeRefund({ status: 'unknown' });
    const verifier: RefundVerifyClient = {
      async verifyRefund() {
        throw new Error('not used');
      },
      async verifyTransaction() {
        return { data: { id: 6675930706 } };
      },
      async listRefundsForTransaction() {
        return { data: [] };
      },
    };

    const summary = await reconciler(verifier).reconcilePendingRefunds({ limit: 500 });
    const ours = summary.results.find((r) => r.reference === reference);
    expect(ours?.outcome).toBe('unresolved');
    expect(ours?.reason).toMatch(/no refund at Paystack/i);
    expect((await row(reference)).status).toBe('unknown');
  });
});
