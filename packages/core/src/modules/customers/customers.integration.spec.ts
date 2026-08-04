import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { createTestDb, schema } from '@installment/db';
import { AuditLogger } from '../audit/audit-logger.service';
import { SYSTEM_ACTORS } from '../../shared/constants/system-actors';
import { PasswordService } from '../../shared/auth/password.service';
import { UsersService } from '../users/users.service';
import { CustomersService } from './customers.service';
import { MockGhanaCardVerifier } from './ghana-card-verifier';
import {
  CustomerNotFoundError,
  GhanaCardNotAttachedError,
  GhanaCardVerificationFailedError,
} from './errors';

const RUN_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!RUN_DB)('CustomersService (integration)', () => {
  const { db, pool } = createTestDb();
  const audit = new AuditLogger();
  const SYSTEM_ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  afterAll(async () => {
    await pool.end();
  });

  function input() {
    const suffix = randomUUID();
    return {
      first_name: 'Ama',
      last_name: 'Mensah',
      email: `ama+${suffix}@example.com`,
      phone: `024${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
      consents: { data_processing: true, credit_scoring: true },
    };
  }

  async function lastAuditEventType(customerId: string): Promise<string | undefined> {
    const rows = await db
      .select({ event_type: schema.audit_events.event_type })
      .from(schema.audit_events)
      .where(
        and(
          eq(schema.audit_events.entity_id, customerId),
          eq(schema.audit_events.entity_type, 'customer'),
        ),
      )
      .orderBy(desc(schema.audit_events.occurred_at))
      .limit(1);
    return rows[0]?.event_type;
  }

  function makeSvc(verifierOpts?: ConstructorParameters<typeof MockGhanaCardVerifier>[0]) {
    return new CustomersService(db, audit, new MockGhanaCardVerifier(verifierOpts));
  }

  it('registers a customer with consents stamped and the phone canonicalised', async () => {
    const svc = makeSvc();
    const created = await svc.register(input(), SYSTEM_ACTOR);

    expect(created.phone.startsWith('+233')).toBe(true);
    expect(created.kyc_tier).toBe(0);
    expect(created.ghana_card_verified).toBe(false);
    expect(created.data_processing_consent_at).not.toBeNull();
    expect(created.credit_scoring_consent_at).not.toBeNull();
    expect(created.marketing_consent_at).toBeNull();
    expect(await lastAuditEventType(created.id)).toBe('customer.registered');
  });

  it('attaches a Ghana Card (invalidates any prior verification) then verifies it and bumps KYC tier to 1', async () => {
    const svc = makeSvc();
    const created = await svc.register(input(), SYSTEM_ACTOR);
    const cardNumber = `GHA-${Math.floor(100_000_000 + Math.random() * 899_999_999)}-0`;

    const attached = await svc.attachGhanaCard(
      created.id,
      { ghana_card_number: cardNumber, ghana_card_image_key: 's3://b/k.jpg' },
      SYSTEM_ACTOR,
    );
    expect(attached.ghana_card_number).toBe(cardNumber);
    expect(attached.ghana_card_verified).toBe(false);
    expect(await lastAuditEventType(created.id)).toBe('customer.ghana_card_attached');

    const verified = await svc.verifyGhanaCard(created.id, SYSTEM_ACTOR);
    expect(verified.ghana_card_verified).toBe(true);
    expect(verified.ghana_card_verified_at).not.toBeNull();
    expect(verified.kyc_tier).toBe(1);
    expect(await lastAuditEventType(created.id)).toBe('customer.ghana_card_verified');
  });

  it('throws when verifying without an attached card', async () => {
    const svc = makeSvc();
    const created = await svc.register(input(), SYSTEM_ACTOR);
    await expect(svc.verifyGhanaCard(created.id, SYSTEM_ACTOR)).rejects.toBeInstanceOf(
      GhanaCardNotAttachedError,
    );
  });

  it('records a failed verification audit row and throws when the verifier rejects', async () => {
    const svc = makeSvc({ alwaysVerified: false, mockReason: 'photo too dark' });
    const created = await svc.register(input(), SYSTEM_ACTOR);
    await svc.attachGhanaCard(
      created.id,
      {
        ghana_card_number: `GHA-${Math.floor(100_000_000 + Math.random() * 899_999_999)}-1`,
        ghana_card_image_key: 's3://b/k.jpg',
      },
      SYSTEM_ACTOR,
    );

    await expect(svc.verifyGhanaCard(created.id, SYSTEM_ACTOR)).rejects.toBeInstanceOf(
      GhanaCardVerificationFailedError,
    );
    expect(await lastAuditEventType(created.id)).toBe('customer.ghana_card_verification_failed');

    const reread = await svc.get(created.id);
    expect(reread.ghana_card_verified).toBe(false);
    expect(reread.kyc_tier).toBe(0);
  });

  it('stores momo details and records consent timestamps idempotently', async () => {
    const svc = makeSvc();
    const created = await svc.register(input(), SYSTEM_ACTOR);

    const withMomo = await svc.setMomo(
      created.id,
      { momo_phone: '0244999000', momo_provider: 'mtn' },
      SYSTEM_ACTOR,
    );
    expect(withMomo.momo_phone).toBe('+233244999000');
    expect(withMomo.momo_provider).toBe('mtn');

    const marketed = await svc.recordConsent(created.id, { type: 'marketing' }, SYSTEM_ACTOR);
    expect(marketed.marketing_consent_at).not.toBeNull();
  });

  it('blocklists and unblocklists with audit', async () => {
    const svc = makeSvc();
    const created = await svc.register(input(), SYSTEM_ACTOR);

    const blocked = await svc.setBlocklist(
      created.id,
      { reason: 'Identity mismatch' },
      SYSTEM_ACTOR,
    );
    expect(blocked.is_on_blocklist).toBe(true);
    expect(blocked.blocklist_reason).toBe('Identity mismatch');
    expect(await lastAuditEventType(created.id)).toBe('customer.blocklisted');

    const unblocked = await svc.removeBlocklist(created.id, SYSTEM_ACTOR);
    expect(unblocked.is_on_blocklist).toBe(false);
    expect(unblocked.blocklist_reason).toBeNull();
    expect(await lastAuditEventType(created.id)).toBe('customer.unblocked');
  });

  it('lists by kyc_tier and is_on_blocklist', async () => {
    const svc = makeSvc();
    const a = await svc.register(input(), SYSTEM_ACTOR);
    const b = await svc.register(input(), SYSTEM_ACTOR);
    await svc.setBlocklist(b.id, { reason: 'test' }, SYSTEM_ACTOR);

    const blockedRows = await svc.list({ is_on_blocklist: true, limit: 200 });
    const blockedIds = blockedRows.map((r) => r.id);
    expect(blockedIds).toContain(b.id);
    expect(blockedIds).not.toContain(a.id);

    const tier0 = await svc.list({ kyc_tier: 0, limit: 200 });
    expect(tier0.map((r) => r.id)).toContain(a.id);
  });

  it('throws CustomerNotFoundError for unknown IDs', async () => {
    const svc = makeSvc();
    await expect(svc.get(randomUUID())).rejects.toBeInstanceOf(CustomerNotFoundError);
    await expect(
      svc.update(randomUUID(), { first_name: 'x' }, SYSTEM_ACTOR),
    ).rejects.toBeInstanceOf(CustomerNotFoundError);
  });

  it('links a customer to its login at user creation and resolves by user id', async () => {
    const svc = makeSvc();
    const users = new UsersService(db, audit, new PasswordService());
    const reg = input();
    const customer = await svc.register(reg, SYSTEM_ACTOR);

    // Before a login exists, the customer is unlinked.
    expect(customer.user_id).toBeNull();

    const user = await users.createCustomerUser(
      { phone: reg.phone, name: 'Ama Mensah' },
      SYSTEM_ACTOR,
    );

    const resolved = await svc.findByUserId(user.id);
    expect(resolved?.id).toBe(customer.id);
    expect(await svc.findByUserId(randomUUID())).toBeUndefined();
  });
});
