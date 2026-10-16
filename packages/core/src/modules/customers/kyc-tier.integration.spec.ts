import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, schema } from '@installment/db';
import { AuditLogger } from '../audit/audit-logger.service';
import { SYSTEM_ACTORS } from '../../shared/constants/system-actors';
import { CustomersService } from './customers.service';
import {
  ManualReviewGhanaCardVerifier,
  MockGhanaCardVerifier,
  type GhanaCardVerifier,
} from './ghana-card-verifier';

const RUN_DB = Boolean(process.env.DATABASE_URL);

/**
 * What each KYC tier means, now that tier 2 means something.
 *
 *   0  no verified Ghana Card
 *   1  a card a person has checked — a compliance officer comparing the scan
 *      with the details on file (`ManualReviewGhanaCardVerifier`)
 *   2  a card the National Identification Authority's records confirm
 *
 * Tier 2 was allowed by the DB CHECK and priced by `score.kyc_tier`, and
 * nothing wrote it. Defining it as the NIA check makes it the one identity
 * signal no other rule already counts: employment and repayment history are
 * scored separately, a forged scan is exactly what a human review can miss.
 *
 * Both demotion paths assumed tier 1 was the only tier a card could earn
 * (`kyc_tier === 1 ? 0 : kyc_tier`), so once anything produces tier 2 a
 * rejected or replaced card would have kept it.
 */
describe.skipIf(!RUN_DB)('KYC tiers from the Ghana Card (integration)', () => {
  const { db, pool } = createTestDb();
  const audit = new AuditLogger();
  const ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  /** Stands in for the NIA client: reports the authority that confirmed it. */
  const nia: GhanaCardVerifier = {
    verify: async () => ({ verified: true, authority: 'nia', raw: { nia: 'match' } }),
  };
  const withNia = new CustomersService(db, audit, nia);
  const withReview = new CustomersService(db, audit, new ManualReviewGhanaCardVerifier());
  const withMock = new CustomersService(db, audit, new MockGhanaCardVerifier());

  afterAll(async () => {
    await pool.end();
  });

  async function customerWithCard(svc: CustomersService) {
    const s = randomUUID();
    const c = await svc.register(
      {
        first_name: 'Tier',
        last_name: 'Test',
        email: `tier+${s}@x.gh`,
        phone: `024${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
      },
      ACTOR,
    );
    await svc.attachGhanaCard(
      c.id,
      {
        ghana_card_number: `GHA-${Math.floor(100_000_000 + Math.random() * 899_999_999)}-0`,
        ghana_card_image_key: `private/kyc/${c.id}/card.jpg`,
      },
      ACTOR,
    );
    return c.id;
  }

  it('earns tier 1 for a card a person has reviewed', async () => {
    const id = await customerWithCard(withReview);
    expect((await withReview.verifyGhanaCard(id, ACTOR)).kyc_tier).toBe(1);
  });

  it('earns tier 1, never 2, from the mock', async () => {
    // The mock must not be able to claim an authority it never consulted.
    const id = await customerWithCard(withMock);
    expect((await withMock.verifyGhanaCard(id, ACTOR)).kyc_tier).toBe(1);
  });

  it('earns tier 2 for a card the NIA confirms', async () => {
    const id = await customerWithCard(withNia);
    expect((await withNia.verifyGhanaCard(id, ACTOR)).kyc_tier).toBe(2);
  });

  it('does not downgrade an NIA-confirmed card when a person re-checks it', async () => {
    const id = await customerWithCard(withNia);
    await withNia.verifyGhanaCard(id, ACTOR);
    expect((await withReview.verifyGhanaCard(id, ACTOR)).kyc_tier).toBe(2);
  });

  /** Puts a verified card at tier 2 directly, independent of how it got there. */
  async function atTier2(): Promise<string> {
    const id = await customerWithCard(withReview);
    await withReview.verifyGhanaCard(id, ACTOR);
    await db.update(schema.customers).set({ kyc_tier: 2 }).where(eq(schema.customers.id, id));
    return id;
  }

  it('takes tier 2 back to 0 when the card is rejected', async () => {
    const id = await atTier2();
    const rejected = await withReview.rejectGhanaCard(id, { reason: 'not the holder' }, ACTOR);
    expect(rejected.kyc_tier).toBe(0);
  });

  it('takes tier 2 back to 0 when a different card is attached', async () => {
    const id = await atTier2();
    const replaced = await withReview.attachGhanaCard(
      id,
      {
        ghana_card_number: `GHA-${Math.floor(100_000_000 + Math.random() * 899_999_999)}-0`,
        ghana_card_image_key: `private/kyc/${id}/other.jpg`,
      },
      ACTOR,
    );
    expect(replaced.kyc_tier).toBe(0);
  });
});
