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

  function cardInput() {
    return {
      ghana_card_number: `GHA-${Math.floor(100_000_000 + Math.random() * 899_999_999)}-0`,
      ghana_card_image_key: 'private/kyc/c/k.jpg',
    };
  }

  async function lastAuditRow(customerId: string) {
    return db
      .select({
        event_type: schema.audit_events.event_type,
        reason: schema.audit_events.reason,
      })
      .from(schema.audit_events)
      .where(
        and(
          eq(schema.audit_events.entity_id, customerId),
          eq(schema.audit_events.entity_type, 'customer'),
        ),
      )
      .orderBy(desc(schema.audit_events.occurred_at))
      .limit(1);
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

  it('rejects a card with a reason, and the reason survives on the audit row', async () => {
    const svc = makeSvc();
    const created = await svc.register(input(), SYSTEM_ACTOR);
    await svc.attachGhanaCard(created.id, cardInput(), SYSTEM_ACTOR);

    const rejected = await svc.rejectGhanaCard(
      created.id,
      { reason: 'Scan is cropped — the card number is cut off' },
      SYSTEM_ACTOR,
    );

    expect(rejected.ghana_card_verified).toBe(false);
    // The card itself stays: it is what was rejected, and re-attaching replaces it.
    expect(rejected.ghana_card_number).not.toBeNull();
    const [row] = await lastAuditRow(created.id);
    expect(row?.event_type).toBe('customer.ghana_card_rejected');
    expect(row?.reason).toBe('Scan is cropped — the card number is cut off');
  });

  it('withdraws an existing verification and takes the KYC tier back down with it', async () => {
    const svc = makeSvc();
    const created = await svc.register(input(), SYSTEM_ACTOR);
    await svc.attachGhanaCard(created.id, cardInput(), SYSTEM_ACTOR);

    const verified = await svc.verifyGhanaCard(created.id, SYSTEM_ACTOR);
    expect(verified.kyc_tier).toBe(1);

    // Nothing but the card raises the tier to 1, so nothing but the card should
    // hold it there once the card is withdrawn.
    const rejected = await svc.rejectGhanaCard(
      created.id,
      { reason: 'Reported stolen after verification' },
      SYSTEM_ACTOR,
    );
    expect(rejected.ghana_card_verified).toBe(false);
    expect(rejected.ghana_card_verified_at).toBeNull();
    expect(rejected.kyc_tier).toBe(0);
  });

  it('refuses to reject a customer who has no card attached', async () => {
    const svc = makeSvc();
    const created = await svc.register(input(), SYSTEM_ACTOR);
    await expect(
      svc.rejectGhanaCard(created.id, { reason: 'nothing to reject' }, SYSTEM_ACTOR),
    ).rejects.toBeInstanceOf(GhanaCardNotAttachedError);
  });

  it('requires a reason — a rejection nobody can read is not a review', async () => {
    const svc = makeSvc();
    const created = await svc.register(input(), SYSTEM_ACTOR);
    await svc.attachGhanaCard(created.id, cardInput(), SYSTEM_ACTOR);
    await expect(svc.rejectGhanaCard(created.id, { reason: '  ' }, SYSTEM_ACTOR)).rejects.toThrow();
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

/**
 * The card's review state, which the customer's own app has to be able to read.
 *
 * Before 0019 the row carried one boolean, so a rejected card and a
 * never-reviewed one were byte-identical — `rejectGhanaCard` clears `verified`
 * and keeps the number and key, which is right, but it left nothing to tell a
 * customer whether to wait or to send a better photo. And the reason lived only
 * in `audit_events`, which they cannot read.
 */
describe.skipIf(!RUN_DB)('Ghana Card review state (integration)', () => {
  const { db, pool } = createTestDb();
  const audit = new AuditLogger();
  const SYSTEM_ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  afterAll(async () => {
    await pool.end();
  });

  const svc = (opts?: ConstructorParameters<typeof MockGhanaCardVerifier>[0]) =>
    new CustomersService(db, audit, new MockGhanaCardVerifier(opts));

  function registration() {
    const suffix = randomUUID();
    return {
      first_name: 'Ama',
      last_name: 'Mensah',
      email: `card+${suffix}@example.com`,
      phone: `024${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
      consents: { data_processing: true, credit_scoring: true },
    };
  }

  const card = () => ({
    ghana_card_number: `GHA-${Math.floor(100_000_000 + Math.random() * 899_999_999)}-0`,
    ghana_card_image_key: 'private/kyc/c/k.jpg',
  });

  it('says nothing at all before a card has been sent', async () => {
    const s = svc();
    const c = await s.register(registration(), SYSTEM_ACTOR);

    const view = await s.ghanaCardStatusFor(c.id);

    // `null`, not 'submitted' — a customer who has sent nothing is not waiting
    // on a reviewer, and the app has to offer them the camera instead.
    expect(view).toMatchObject({
      status: null,
      card_number_masked: null,
      has_scan: false,
      verified: false,
      rejection_reason: null,
      kyc_tier: 0,
    });
  });

  it('is submitted once sent, and masks the number', async () => {
    const s = svc();
    const c = await s.register(registration(), SYSTEM_ACTOR);

    await s.attachGhanaCard(
      c.id,
      { ...card(), ghana_card_number: 'GHA-123456789-0' },
      SYSTEM_ACTOR,
    );
    const view = await s.ghanaCardStatusFor(c.id);

    expect(view.status).toBe('submitted');
    expect(view.has_scan).toBe(true);
    // Enough to recognise their own card, useless to anyone else.
    expect(view.card_number_masked).toBe('GHA-•••••6789-0');
    expect(view.card_number_masked).not.toContain('12345');
  });

  it('carries the reviewer’s reason to the customer on a rejection', async () => {
    const s = svc();
    const c = await s.register(registration(), SYSTEM_ACTOR);
    await s.attachGhanaCard(c.id, card(), SYSTEM_ACTOR);

    await s.rejectGhanaCard(c.id, { reason: 'The photo is too dark to read' }, SYSTEM_ACTOR);
    const view = await s.ghanaCardStatusFor(c.id);

    expect(view.status).toBe('rejected');
    // The whole point: a customer told only "not verified" cannot act.
    expect(view.rejection_reason).toBe('The photo is too dark to read');
    expect(view.reviewed_at).not.toBeNull();
  });

  it('distinguishes a rejected card from one nobody has looked at yet', async () => {
    // The state that was unrepresentable. Both rows have a number, a key and
    // `verified = false`; only the status tells them apart.
    const s = svc();
    const waiting = await s.register(registration(), SYSTEM_ACTOR);
    const refused = await s.register(registration(), SYSTEM_ACTOR);
    await s.attachGhanaCard(waiting.id, card(), SYSTEM_ACTOR);
    await s.attachGhanaCard(refused.id, card(), SYSTEM_ACTOR);
    await s.rejectGhanaCard(refused.id, { reason: 'Expired' }, SYSTEM_ACTOR);

    expect((await s.ghanaCardStatusFor(waiting.id)).status).toBe('submitted');
    expect((await s.ghanaCardStatusFor(refused.id)).status).toBe('rejected');
  });

  it('withdraws the tier when a different card is sent', async () => {
    // `rejectGhanaCard` lowers the tier because "that tier was raised by this
    // card and nothing else raises it". Re-attaching withdraws the same
    // verification, so it has to do the same — otherwise the scoring engine
    // goes on paying 50 points for a card nobody has looked at.
    const s = svc();
    const c = await s.register(registration(), SYSTEM_ACTOR);
    await s.attachGhanaCard(c.id, card(), SYSTEM_ACTOR);
    await s.verifyGhanaCard(c.id, SYSTEM_ACTOR);
    expect((await s.ghanaCardStatusFor(c.id)).kyc_tier).toBe(1);

    await s.attachGhanaCard(c.id, card(), SYSTEM_ACTOR);
    const view = await s.ghanaCardStatusFor(c.id);

    expect(view).toMatchObject({ status: 'submitted', verified: false, kyc_tier: 0 });
  });

  it('clears the old reason when a better photo is sent', async () => {
    const s = svc();
    const c = await s.register(registration(), SYSTEM_ACTOR);
    await s.attachGhanaCard(c.id, card(), SYSTEM_ACTOR);
    await s.rejectGhanaCard(c.id, { reason: 'Too dark' }, SYSTEM_ACTOR);

    await s.attachGhanaCard(c.id, card(), SYSTEM_ACTOR);
    const view = await s.ghanaCardStatusFor(c.id);

    // A customer who has acted on the feedback is waiting again, not still
    // rejected — leaving the reason would have their screen contradict what
    // they just did.
    expect(view.status).toBe('submitted');
    expect(view.rejection_reason).toBeNull();
    expect(view.reviewed_at).toBeNull();
  });

  it('is approved once verified, and the tier goes with it', async () => {
    const s = svc();
    const c = await s.register(registration(), SYSTEM_ACTOR);
    await s.attachGhanaCard(c.id, card(), SYSTEM_ACTOR);

    await s.verifyGhanaCard(c.id, SYSTEM_ACTOR);
    const view = await s.ghanaCardStatusFor(c.id);

    expect(view).toMatchObject({ status: 'approved', verified: true, kyc_tier: 1 });
    expect(view.verified_at).not.toBeNull();
    // Tier 1, not 2 — nothing in this system sets tier 2, so the 100-point band
    // of `score.kyc_tier` is unreachable. Pinned here so the day somebody
    // decides what earns tier 2, this test is what tells them the decision has
    // a home.
    expect(view.kyc_tier).not.toBe(2);
  });

  it('takes the tier back down when an approved card is later rejected', async () => {
    const s = svc();
    const c = await s.register(registration(), SYSTEM_ACTOR);
    await s.attachGhanaCard(c.id, card(), SYSTEM_ACTOR);
    await s.verifyGhanaCard(c.id, SYSTEM_ACTOR);

    await s.rejectGhanaCard(c.id, { reason: 'Belongs to someone else' }, SYSTEM_ACTOR);
    const view = await s.ghanaCardStatusFor(c.id);

    expect(view).toMatchObject({ status: 'rejected', verified: false, kyc_tier: 0 });
  });

  // ---------------------------------------------------------------- the schema

  it('refuses a row where the boolean and the status disagree', async () => {
    // Two columns for one fact, so the table refuses to hold a contradiction:
    // without this, a writer that flipped one and forgot the other would give
    // the scoring engine and the customer's own screen different answers.
    const s = svc();
    const c = await s.register(registration(), SYSTEM_ACTOR);
    await s.attachGhanaCard(c.id, card(), SYSTEM_ACTOR);

    await expect(
      db
        .update(schema.customers)
        .set({ ghana_card_verified: true })
        .where(eq(schema.customers.id, c.id)),
    ).rejects.toThrow();

    await expect(
      db
        .update(schema.customers)
        .set({ ghana_card_status: 'approved' })
        .where(eq(schema.customers.id, c.id)),
    ).rejects.toThrow();
  });

  it('refuses “verified” on a customer with no card at all', async () => {
    // The shape a CHECK on the bare comparison would have let through: with a
    // NULL status, `verified = (status = 'approved')` is NULL, and a CHECK
    // passes on NULL.
    const s = svc();
    const c = await s.register(registration(), SYSTEM_ACTOR);

    await expect(
      db
        .update(schema.customers)
        .set({ ghana_card_verified: true })
        .where(eq(schema.customers.id, c.id)),
    ).rejects.toThrow();
  });

  it('refuses a status with no card behind it', async () => {
    const s = svc();
    const c = await s.register(registration(), SYSTEM_ACTOR);

    await expect(
      db
        .update(schema.customers)
        .set({ ghana_card_status: 'submitted' })
        .where(eq(schema.customers.id, c.id)),
    ).rejects.toThrow();
  });
});
