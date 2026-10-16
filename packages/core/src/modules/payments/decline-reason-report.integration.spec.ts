import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { createTestDb, schema } from '@installment/db';
import { AuditLogger } from '../audit/audit-logger.service';
import { SYSTEM_ACTORS } from '../../shared/constants/system-actors';
import { MerchantsService } from '../merchants/merchants.service';
import { CustomersService } from '../customers/customers.service';
import { MockGhanaCardVerifier } from '../customers/ghana-card-verifier';
import { PlanTemplatesService } from '../plans/plan-templates.service';
import { ApplicationsService } from '../applications/applications.service';
import { CustomerPlansService } from '../schedules/customer-plans.service';
import { DeclineReasonReport } from './decline-reason-report';

const RUN_DB = Boolean(process.env.DATABASE_URL);

/**
 * What Paystack has actually been sending as decline reasons.
 *
 * `failure_reason` and the raw response have been stored on every failed
 * attempt all along; nothing read them. So if real declines arrive as prose
 * the map has never matched one, every decline has been retried as
 * `ambiguous`, and the evidence sat in a column no one queried.
 *
 * The report reads the window it is asked for and labels each reason the way
 * the classifier will treat it. The fixture uses reasons unique to this run so
 * other suites' rows cannot change the counts it asserts.
 */
describe.skipIf(!RUN_DB)('DeclineReasonReport (integration)', () => {
  const { db, pool } = createTestDb();
  const audit = new AuditLogger();
  const report = new DeclineReasonReport(db);
  const ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };
  const run = randomUUID().slice(0, 8);
  const PROSE = `Insufficient Funds ${run}`;
  const NEW_CODE = `new_code_${run}`;

  let scheduleId: string;
  let planId: string;
  const attemptIds: string[] = [];

  beforeAll(async () => {
    const s = randomUUID();
    const merchant = await new MerchantsService(db, audit).create(
      {
        business_name: `Declines ${s}`,
        legal_name: `Declines ${s}`,
        email: `dr+${s}@x.gh`,
        phone: '+233244000000',
      },
      ACTOR,
    );
    const customer = await new CustomersService(db, audit, new MockGhanaCardVerifier()).register(
      {
        first_name: 'De',
        last_name: 'Clined',
        email: `dc+${s}@x.gh`,
        phone: `024${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
      },
      ACTOR,
    );
    const template = await new PlanTemplatesService(db, audit).create(
      {
        name: `Declines ${s}`,
        business_model: 'bnpl',
        number_of_installments: 4,
        installment_frequency_days: 7,
        min_amount_pesewas: 1_000,
        max_amount_pesewas: 10_000_000,
      },
      ACTOR,
    );
    const apps = new ApplicationsService(db, audit);
    const app = await apps.submit(
      {
        customer_id: customer.id,
        merchant_id: merchant.id,
        plan_template_id: template.id,
        order_reference: `ORD-${s}`,
        order_amount_pesewas: 100_000,
        merchant_category: 'electronics',
      },
      ACTOR,
    );
    await apps.recordDecision(app.id, { outcome: 'approved' }, ACTOR);
    const { plan, schedule } = await new CustomerPlansService(db, audit).activateFromApplication(
      app.id,
      ACTOR,
    );
    planId = plan.id;
    scheduleId = schedule[0]!.id;

    // Three prose declines, one new code, one mapped token, one placeholder of
    // our own — plus rows that must not count: an old one, and one that never
    // failed.
    const now = new Date();
    const old = new Date(now.getTime() - 40 * 86_400_000);
    const rows: Array<{ reason: string | null; status: 'failed' | 'unknown'; at: Date }> = [
      { reason: PROSE, status: 'failed', at: now },
      { reason: PROSE, status: 'failed', at: now },
      { reason: PROSE, status: 'failed', at: now },
      { reason: NEW_CODE, status: 'failed', at: now },
      { reason: PROSE, status: 'failed', at: old },
      { reason: NEW_CODE, status: 'unknown', at: now },
    ];
    let n = 0;
    for (const r of rows) {
      n += 1;
      const [row] = await db
        .insert(schema.payment_attempts)
        .values({
          schedule_id: scheduleId,
          customer_plan_id: planId,
          provider: 'paystack',
          channel: 'auto_debit',
          payment_method: 'momo',
          amount_pesewas: 25_000,
          idempotency_key: `${scheduleId}:decline:${run}:${n}`,
          status: r.status,
          failure_reason: r.reason,
          failed_at: r.status === 'failed' ? r.at.toISOString() : null,
          initiated_at: r.at.toISOString(),
        })
        .returning({ id: schema.payment_attempts.id });
      attemptIds.push(row!.id);
    }
  });

  afterAll(async () => {
    await db.delete(schema.payment_attempts).where(inArray(schema.payment_attempts.id, attemptIds));
    await pool.end();
  });

  const since = () => new Date(Date.now() - 30 * 86_400_000);

  it('counts failed attempts per reason inside the window', async () => {
    const rows = await report.summarise({ since: since() });
    const prose = rows.find((r) => r.reason === PROSE);
    // Three in the window; the 40-day-old one is outside it.
    expect(prose?.attempts).toBe(3);
    // The `unknown` attempt is not a decline — nobody knows yet whether it failed.
    expect(rows.find((r) => r.reason === NEW_CODE)?.attempts).toBe(1);
  });

  it('labels each reason the way the classifier will treat it', async () => {
    const rows = await report.summarise({ since: since() });
    expect(rows.find((r) => r.reason === PROSE)).toMatchObject({
      source: 'unrecognised',
      classified_as: 'ambiguous',
    });
  });

  it('lists only the reasons the map does not know, for the alert', async () => {
    const reasons = (await report.unrecognised({ since: since() })).map((r) => r.reason);
    expect(reasons).toContain(PROSE);
    expect(reasons).toContain(NEW_CODE);
    expect(reasons).not.toContain('charge_failed');
    expect(reasons).not.toContain('insufficient_funds');
  });

  it('returns the most frequent reasons first', async () => {
    const rows = await report.summarise({ since: since() });
    const counts = rows.map((r) => r.attempts);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });
});
