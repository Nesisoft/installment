import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { createTestDb, schema } from '@installment/db';
import { AuditLogger } from '../audit/audit-logger.service';
import { SYSTEM_ACTORS } from '../../shared/constants/system-actors';
import { approveRequiredMerchantKyc } from '../../shared/test-fixtures/merchant-kyc';
import { IllegalMerchantTransitionError, type MerchantEvent } from './state-machine';
import { MerchantsService } from './merchants.service';
import { MerchantNotFoundError } from './errors';

const RUN_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!RUN_DB)('MerchantsService (integration)', () => {
  const { db, pool } = createTestDb();
  const audit = new AuditLogger();
  const merchants = new MerchantsService(db, audit);

  const SYSTEM_ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  afterAll(async () => {
    await pool.end();
  });

  function input(suffix: string = randomUUID()) {
    return {
      business_name: `Ejua Mart ${suffix}`,
      legal_name: `Ejua Ghana Limited ${suffix}`,
      email: `ops+${suffix}@ejua.gh`,
      phone: '+233244123456',
      default_mdr_bps: 400,
      default_reserve_bps: 500,
    };
  }

  async function lastAuditEventType(merchantId: string): Promise<string | undefined> {
    const rows = await db
      .select({ event_type: schema.audit_events.event_type })
      .from(schema.audit_events)
      .where(
        and(
          eq(schema.audit_events.entity_id, merchantId),
          eq(schema.audit_events.entity_type, 'merchant'),
        ),
      )
      .orderBy(desc(schema.audit_events.occurred_at))
      .limit(1);
    return rows[0]?.event_type;
  }

  it('creates a merchant in pending_kyc and writes a creation audit row', async () => {
    const created = await merchants.create(input(), SYSTEM_ACTOR);

    expect(created.status).toBe('pending_kyc');
    expect(created.onboarded_at).toBeNull();
    expect(created.default_mdr_bps).toBe(400);
    expect(await lastAuditEventType(created.id)).toBe('merchant.created');

    const fetched = await merchants.get(created.id);
    expect(fetched.id).toBe(created.id);
  });

  it('lists merchants filtered by status and orders newest-first', async () => {
    const a = await merchants.create(input(), SYSTEM_ACTOR);
    const b = await merchants.create(input(), SYSTEM_ACTOR);

    const all = await merchants.list({ status: 'pending_kyc', limit: 100 });
    const ids = all.map((r) => r.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    // Most-recent first: b's index should be < a's index.
    expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(a.id));
  });

  it('updates mutable fields without touching status', async () => {
    const created = await merchants.create(input(), SYSTEM_ACTOR);
    const updated = await merchants.update(
      created.id,
      { business_name: 'Renamed Co' },
      SYSTEM_ACTOR,
    );
    expect(updated.business_name).toBe('Renamed Co');
    expect(updated.status).toBe(created.status);
    expect(await lastAuditEventType(created.id)).toBe('merchant.updated');
  });

  it('walks the lifecycle: pending_kyc → active → suspended → active → offboarded', async () => {
    const created = await merchants.create(input(), SYSTEM_ACTOR);
    // The first activation now needs approved KYC documents behind it — see
    // merchant-kyc.integration.spec.ts for the gate itself. This test is about
    // the state machine, so it satisfies the requirement rather than working
    // around it.
    await approveRequiredMerchantKyc(db, created.id, SYSTEM_ACTOR, audit);

    const activated = await merchants.transition(
      created.id,
      { event: 'activate' satisfies MerchantEvent },
      SYSTEM_ACTOR,
    );
    expect(activated.status).toBe('active');
    expect(activated.onboarded_at).not.toBeNull();
    expect(await lastAuditEventType(created.id)).toBe('merchant.activate');

    const suspended = await merchants.transition(
      created.id,
      { event: 'suspend', reason: 'KYC drift' },
      SYSTEM_ACTOR,
    );
    expect(suspended.status).toBe('suspended');
    expect(suspended.suspension_reason).toBe('KYC drift');
    expect(suspended.suspended_at).not.toBeNull();

    const reactivated = await merchants.transition(
      created.id,
      { event: 'reactivate' },
      SYSTEM_ACTOR,
    );
    expect(reactivated.status).toBe('active');
    expect(reactivated.suspended_at).toBeNull();
    expect(reactivated.suspension_reason).toBeNull();
    // onboarded_at is preserved across reactivation:
    expect(reactivated.onboarded_at).toBe(activated.onboarded_at);

    const offboarded = await merchants.transition(
      created.id,
      { event: 'offboard', reason: 'Mutually agreed exit' },
      SYSTEM_ACTOR,
    );
    expect(offboarded.status).toBe('offboarded');
    expect(await lastAuditEventType(created.id)).toBe('merchant.offboard');
  });

  it('rejects illegal transitions (pending_kyc → suspend)', async () => {
    const created = await merchants.create(input(), SYSTEM_ACTOR);
    await expect(
      merchants.transition(created.id, { event: 'suspend' }, SYSTEM_ACTOR),
    ).rejects.toBeInstanceOf(IllegalMerchantTransitionError);
  });

  it('reads status fresh under SELECT FOR UPDATE — a stale "activate" is rejected as illegal', async () => {
    const created = await merchants.create(input(), SYSTEM_ACTOR);
    // Someone else "wins" the race and activates first.
    await db
      .update(schema.merchants)
      .set({ status: 'active', onboarded_at: new Date().toISOString() })
      .where(eq(schema.merchants.id, created.id));

    // Our transition reloads under a row lock, sees active, and rejects
    // a second activate as an illegal transition (the state machine is
    // the safety net even when the optimistic UPDATE guard would have
    // also caught the conflict).
    await expect(
      merchants.transition(created.id, { event: 'activate' }, SYSTEM_ACTOR),
    ).rejects.toBeInstanceOf(IllegalMerchantTransitionError);
  });

  it('attaches a Paystack recipient code and audits it', async () => {
    const created = await merchants.create(input(), SYSTEM_ACTOR);
    const attached = await merchants.attachPaystackRecipient(
      created.id,
      {
        paystack_recipient_code: 'RCP_test_123',
        bank_account_number: '0123456789',
        bank_code: '300302',
        bank_account_name: 'Ejua Mart',
      },
      SYSTEM_ACTOR,
    );
    expect(attached.paystack_recipient_code).toBe('RCP_test_123');
    expect(await lastAuditEventType(created.id)).toBe('merchant.paystack_recipient_attached');
  });

  it('throws MerchantNotFoundError for unknown IDs', async () => {
    await expect(merchants.get(randomUUID())).rejects.toBeInstanceOf(MerchantNotFoundError);
    await expect(
      merchants.update(randomUUID(), { business_name: 'x' }, SYSTEM_ACTOR),
    ).rejects.toBeInstanceOf(MerchantNotFoundError);
    await expect(
      merchants.transition(randomUUID(), { event: 'activate' }, SYSTEM_ACTOR),
    ).rejects.toBeInstanceOf(MerchantNotFoundError);
  });

  it('rejects duplicate email at the DB unique constraint', async () => {
    const base = input();
    await merchants.create(base, SYSTEM_ACTOR);
    await expect(merchants.create(base, SYSTEM_ACTOR)).rejects.toThrow();
  });
});
