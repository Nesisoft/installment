import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { createTestDb, schema } from '@installment/db';
import { AuditLogger } from '../audit/audit-logger.service';
import { SYSTEM_ACTORS } from '../../shared/constants/system-actors';
import { MerchantsService } from './merchants.service';
import {
  MerchantKycAlreadyApprovedError,
  MerchantKycDocumentNotFoundError,
  MerchantKycIncompleteError,
  MerchantNotFoundError,
} from './errors';
import {
  MerchantKycService,
  REQUIRED_MERCHANT_KYC_DOCS,
  type MerchantKycDocType,
} from './merchant-kyc.service';

const RUN_DB = Boolean(process.env.DATABASE_URL);

/**
 * Merchant KYC, and the activation it now gates.
 *
 * The thing under test is not really the table — it is that a merchant can no
 * longer leave `pending_kyc` because somebody pressed a button. Since merchants
 * could sign themselves up (#62), activation with no evidence behind it was the
 * whole of onboarding: anybody could open a shop and wait to be let in.
 *
 * Written against Postgres rather than a fixture because two of the rules live
 * in the schema — the partial unique index that keeps "the current document"
 * unambiguous, and the CHECK that refuses half a decision — and a unit test
 * over an in-memory object would assert neither.
 */
describe.skipIf(!RUN_DB)('MerchantKycService (integration)', () => {
  const { db, pool } = createTestDb();
  const audit = new AuditLogger();
  const merchants = new MerchantsService(db, audit);
  const kyc = new MerchantKycService(db, audit);
  const SYSTEM_ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  afterAll(async () => {
    await pool.end();
  });

  async function newMerchant() {
    const suffix = randomUUID();
    return merchants.create(
      {
        business_name: `Adepa Couture ${suffix}`,
        legal_name: `Adepa Ghana Limited ${suffix}`,
        email: `ops+${suffix}@adepa.gh`,
        phone: '+233244123456',
      },
      SYSTEM_ACTOR,
    );
  }

  const keyFor = (merchantId: string, docType: string) =>
    `private/merchant-kyc/${merchantId}/${docType}-${randomUUID()}.jpg`;

  async function submit(merchantId: string, doc_type: MerchantKycDocType) {
    return kyc.submit(
      merchantId,
      { doc_type, storage_key: keyFor(merchantId, doc_type) },
      SYSTEM_ACTOR,
    );
  }

  async function submitAndApproveAll(merchantId: string) {
    for (const doc_type of REQUIRED_MERCHANT_KYC_DOCS) {
      const doc = await submit(merchantId, doc_type);
      await kyc.approve(doc.id, SYSTEM_ACTOR);
    }
  }

  async function auditTypes(merchantId: string): Promise<string[]> {
    const rows = await db
      .select({ event_type: schema.audit_events.event_type })
      .from(schema.audit_events)
      .where(
        and(
          eq(schema.audit_events.entity_id, merchantId),
          eq(schema.audit_events.entity_type, 'merchant'),
        ),
      )
      .orderBy(desc(schema.audit_events.occurred_at));
    return rows.map((r) => r.event_type);
  }

  // ------------------------------------------------------- the activation gate

  it('refuses a first activation with nothing submitted, naming what is missing', async () => {
    const merchant = await newMerchant();

    await expect(
      merchants.transition(merchant.id, { event: 'activate' }, SYSTEM_ACTOR),
    ).rejects.toBeInstanceOf(MerchantKycIncompleteError);

    // The message is what a reviewer reads, so it has to say which documents.
    await expect(
      merchants.transition(merchant.id, { event: 'activate' }, SYSTEM_ACTOR),
    ).rejects.toThrow(/ghana_card_front/);

    expect((await merchants.get(merchant.id)).status).toBe('pending_kyc');
  });

  it('refuses while documents are submitted but not yet reviewed', async () => {
    const merchant = await newMerchant();
    for (const doc_type of REQUIRED_MERCHANT_KYC_DOCS) await submit(merchant.id, doc_type);

    // Uploading is not being verified. This is the case the old flow could not
    // distinguish, because there was nothing to upload.
    await expect(
      merchants.transition(merchant.id, { event: 'activate' }, SYSTEM_ACTOR),
    ).rejects.toBeInstanceOf(MerchantKycIncompleteError);
  });

  it('refuses when one required document is still rejected', async () => {
    const merchant = await newMerchant();
    for (const doc_type of REQUIRED_MERCHANT_KYC_DOCS) {
      const doc = await submit(merchant.id, doc_type);
      if (doc_type === 'shop_photo') {
        await kyc.reject(doc.id, { reason: 'Photograph is of a photocopy' }, SYSTEM_ACTOR);
      } else {
        await kyc.approve(doc.id, SYSTEM_ACTOR);
      }
    }

    await expect(
      merchants.transition(merchant.id, { event: 'activate' }, SYSTEM_ACTOR),
    ).rejects.toThrow(/shop_photo/);
  });

  it('allows the activation once every required document is approved', async () => {
    const merchant = await newMerchant();
    await submitAndApproveAll(merchant.id);

    const activated = await merchants.transition(merchant.id, { event: 'activate' }, SYSTEM_ACTOR);

    expect(activated.status).toBe('active');
    expect(activated.onboarded_at).not.toBeNull();
  });

  it('does not demand the optional business registration', async () => {
    // A market trader with a stall and a Ghana Card is who this marketplace is
    // for; a certificate of incorporation would shut them out.
    const merchant = await newMerchant();
    await submitAndApproveAll(merchant.id);

    expect(REQUIRED_MERCHANT_KYC_DOCS).not.toContain('business_registration');
    expect((await kyc.statusFor(merchant.id)).complete).toBe(true);
  });

  it('lets a suspended merchant be reactivated without re-submitting anything', async () => {
    // Reactivation is a decision about somebody already verified. Making them
    // send a Ghana Card again would strand anyone suspended for an unrelated
    // reason — a payout problem, a dispute — behind a KYC queue.
    const merchant = await newMerchant();
    await submitAndApproveAll(merchant.id);
    await merchants.transition(merchant.id, { event: 'activate' }, SYSTEM_ACTOR);
    await merchants.transition(
      merchant.id,
      { event: 'suspend', reason: 'payout bounced' },
      SYSTEM_ACTOR,
    );

    const reactivated = await merchants.transition(
      merchant.id,
      { event: 'reactivate' },
      SYSTEM_ACTOR,
    );

    expect(reactivated.status).toBe('active');
  });

  it('exempts a merchant who was already trading before review existed', async () => {
    // 0016 stamps `kyc_exempt_before` on everyone past pending_kyc at migration
    // time. Backfilling approved documents instead would have put a decision
    // nobody made into the record.
    const merchant = await newMerchant();
    await db
      .update(schema.merchants)
      .set({ kyc_exempt_before: new Date().toISOString() })
      .where(eq(schema.merchants.id, merchant.id));

    const activated = await merchants.transition(merchant.id, { event: 'activate' }, SYSTEM_ACTOR);

    expect(activated.status).toBe('active');
    // And the status still tells the truth about their evidence.
    const status = await kyc.statusFor(merchant.id);
    expect(status.exempt).toBe(true);
    expect(status.complete).toBe(false);
    expect(status.outstanding).toEqual([...REQUIRED_MERCHANT_KYC_DOCS]);
  });

  // ------------------------------------------------------------- submitting

  it('reports what is outstanding as documents are approved one by one', async () => {
    const merchant = await newMerchant();
    expect((await kyc.statusFor(merchant.id)).outstanding).toEqual([...REQUIRED_MERCHANT_KYC_DOCS]);

    const front = await submit(merchant.id, 'ghana_card_front');
    await kyc.approve(front.id, SYSTEM_ACTOR);

    const status = await kyc.statusFor(merchant.id);
    expect(status.outstanding).not.toContain('ghana_card_front');
    expect(status.outstanding).toContain('ghana_card_back');
    expect(status.complete).toBe(false);
  });

  it('corrects an unreviewed submission in place rather than piling them up', async () => {
    const merchant = await newMerchant();
    const first = await submit(merchant.id, 'shop_photo');
    const second = await submit(merchant.id, 'shop_photo');

    // Same row, new key: a merchant fixing a blurred photo before anyone has
    // looked should not leave a reviewer choosing between two.
    expect(second.id).toBe(first.id);
    expect(second.storage_key).not.toBe(first.storage_key);
    expect((await kyc.statusFor(merchant.id)).documents).toHaveLength(1);
    expect(await auditTypes(merchant.id)).toContain('merchant.kyc_document_replaced');
  });

  it('refuses to let a merchant replace a document a reviewer approved', async () => {
    // The security property: a merchant who could swap an approved card for
    // something else would keep the activation the real card earned.
    const merchant = await newMerchant();
    const doc = await submit(merchant.id, 'ghana_card_front');
    await kyc.approve(doc.id, SYSTEM_ACTOR);

    await expect(submit(merchant.id, 'ghana_card_front')).rejects.toBeInstanceOf(
      MerchantKycAlreadyApprovedError,
    );
  });

  it('accepts a fresh document beside a rejected one, keeping the refusal readable', async () => {
    const merchant = await newMerchant();
    const first = await submit(merchant.id, 'ghana_card_back');
    await kyc.reject(first.id, { reason: 'Back of the card is cut off' }, SYSTEM_ACTOR);

    const second = await submit(merchant.id, 'ghana_card_back');

    expect(second.id).not.toBe(first.id);
    const { documents } = await kyc.statusFor(merchant.id);
    expect(documents).toHaveLength(2);
    const rejected = documents.find((d) => d.id === first.id);
    expect(rejected?.status).toBe('rejected');
    expect(rejected?.rejection_reason).toBe('Back of the card is cut off');
  });

  // -------------------------------------------------------------- reviewing

  it('records the reason on a rejection and refuses one without', async () => {
    const merchant = await newMerchant();
    const doc = await submit(merchant.id, 'shop_photo');

    await expect(kyc.reject(doc.id, { reason: '   ' }, SYSTEM_ACTOR)).rejects.toThrow();

    const { document } = await kyc.reject(doc.id, { reason: 'Not a shop' }, SYSTEM_ACTOR);
    expect(document.status).toBe('rejected');
    expect(document.rejection_reason).toBe('Not a shop');
    expect(document.reviewed_at).not.toBeNull();
  });

  it('clears a rejection reason when the same document is later approved', async () => {
    // The CHECK constraint refuses an approved row that still carries a reason,
    // so this would fail in the database if the service left it behind.
    const merchant = await newMerchant();
    const doc = await submit(merchant.id, 'shop_photo');
    await kyc.reject(doc.id, { reason: 'Too dark' }, SYSTEM_ACTOR);

    const { document } = await kyc.approve(doc.id, SYSTEM_ACTOR);

    expect(document.status).toBe('approved');
    expect(document.rejection_reason).toBeNull();
  });

  it('returns the merchant’s whole KYC state alongside a decision', async () => {
    // So the console can re-render the outstanding list without a second call —
    // and so "you have just approved the last one" is visible immediately.
    const merchant = await newMerchant();
    const docs = [];
    for (const doc_type of REQUIRED_MERCHANT_KYC_DOCS)
      docs.push(await submit(merchant.id, doc_type));
    for (const d of docs.slice(0, -1)) await kyc.approve(d.id, SYSTEM_ACTOR);

    const { status } = await kyc.approve(docs[docs.length - 1]!.id, SYSTEM_ACTOR);

    expect(status.complete).toBe(true);
    expect(status.outstanding).toEqual([]);
  });

  it('audits every submission and decision against the merchant', async () => {
    const merchant = await newMerchant();
    const doc = await submit(merchant.id, 'ghana_card_front');
    await kyc.reject(doc.id, { reason: 'blurred' }, SYSTEM_ACTOR);
    await submit(merchant.id, 'ghana_card_front');

    const types = await auditTypes(merchant.id);
    expect(types).toContain('merchant.kyc_document_submitted');
    expect(types).toContain('merchant.kyc_rejected');
  });

  // -------------------------------------------------------------- not found

  it('treats an unknown merchant and an unknown document as absent', async () => {
    await expect(kyc.statusFor(randomUUID())).rejects.toBeInstanceOf(MerchantNotFoundError);
    await expect(
      kyc.submit(
        randomUUID(),
        { doc_type: 'shop_photo', storage_key: 'private/merchant-kyc/x/y.jpg' },
        SYSTEM_ACTOR,
      ),
    ).rejects.toBeInstanceOf(MerchantNotFoundError);
    await expect(kyc.approve(randomUUID(), SYSTEM_ACTOR)).rejects.toBeInstanceOf(
      MerchantKycDocumentNotFoundError,
    );
  });
});
