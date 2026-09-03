import { and, desc, eq, inArray, isNull, ne } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import { AuditLogger } from '../audit/audit-logger.service';
import { runInTransaction } from '../../shared/event-bus/transaction';
import {
  rejectKycDocumentSchema,
  submitKycDocumentSchema,
  type RejectKycDocumentInput,
  type SubmitKycDocumentInput,
} from './dto';
import {
  MerchantKycAlreadyApprovedError,
  MerchantKycDocumentNotFoundError,
  MerchantNotFoundError,
} from './errors';
import type { MerchantActor } from './merchants.service';

const k = schema.merchant_kyc_documents;
const m = schema.merchants;

export const MERCHANT_KYC_DOC_TYPES = [
  'ghana_card_front',
  'ghana_card_back',
  'shop_photo',
  'business_registration',
] as const;
export type MerchantKycDocType = (typeof MERCHANT_KYC_DOC_TYPES)[number];

/**
 * What has to be approved before a merchant can be activated.
 *
 * `business_registration` is deliberately outside this list: a market trader
 * with a stall and a Ghana Card is exactly who this marketplace is for, and
 * requiring a certificate of incorporation would shut them out. It is accepted
 * as extra evidence, not demanded.
 */
export const REQUIRED_MERCHANT_KYC_DOCS: readonly MerchantKycDocType[] = [
  'ghana_card_front',
  'ghana_card_back',
  'shop_photo',
];

export type MerchantKycDocument = typeof schema.merchant_kyc_documents.$inferSelect;

export interface MerchantKycStatus {
  documents: MerchantKycDocument[];
  /** Required types with no approved document yet. Empty means ready to review. */
  outstanding: MerchantKycDocType[];
  /** Every required type is approved. */
  complete: boolean;
  /**
   * True for a merchant activated before document review existed. They keep
   * trading; `complete` still reports the truth about their evidence.
   */
  exempt: boolean;
}

/**
 * Which required documents a merchant still owes, inside a caller's transaction.
 *
 * Exported as a function rather than a method so `MerchantsService.transition`
 * can consult it on `activate` without taking a new constructor dependency —
 * twenty-odd fixtures build a `MerchantsService(db, audit)` and none of them
 * care about KYC.
 */
export async function outstandingKycDocs(
  tx: Pick<Database, 'select'>,
  merchantId: string,
): Promise<MerchantKycDocType[]> {
  const approved = await tx
    .select({ doc_type: k.doc_type })
    .from(k)
    .where(
      and(
        eq(k.merchant_id, merchantId),
        eq(k.status, 'approved'),
        inArray(k.doc_type, [...REQUIRED_MERCHANT_KYC_DOCS]),
      ),
    );
  const have = new Set(approved.map((r) => r.doc_type));
  return REQUIRED_MERCHANT_KYC_DOCS.filter((t) => !have.has(t));
}

/**
 * The evidence a merchant sends, and a reviewer's decision on it.
 *
 * Merchants have sat in `pending_kyc` since the schema was written with nothing
 * able to move them out of it but an admin pressing Activate against no
 * evidence at all — the Ghana Card columns are on `customers`, and the
 * `kyc_document` upload purpose belongs to a customer. Since merchants could
 * sign themselves up (#62) that gap has been the whole of onboarding: anybody
 * could open a shop and wait for somebody to click a button.
 *
 * The keys here are minted by the same presigned-upload flow product photos
 * use, under `private/merchant-kyc/<merchant_id>/`, and checked against the
 * caller's own prefix before they are stored — a merchant cannot submit
 * somebody else's document as their own.
 */
export class MerchantKycService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditLogger,
  ) {}

  // ------------------------------------------------------------------ reading

  async statusFor(merchantId: string): Promise<MerchantKycStatus> {
    const merchant = await this.loadMerchant(merchantId);
    const [documents, outstanding] = await Promise.all([
      this.db.select().from(k).where(eq(k.merchant_id, merchantId)).orderBy(desc(k.created_at)),
      outstandingKycDocs(this.db, merchantId),
    ]);

    return {
      documents,
      outstanding,
      complete: outstanding.length === 0,
      exempt: merchant.kyc_exempt_before !== null,
    };
  }

  // --------------------------------------------------------------- submitting

  /**
   * Attach an uploaded document, or correct one nobody has looked at yet.
   *
   * A merchant fixing a blurred photo before review updates that row in place
   * rather than piling up submissions; once a reviewer has approved a type, the
   * merchant cannot replace it (see {@link MerchantKycAlreadyApprovedError}).
   * A rejected row stays where it is and the new upload sits beside it, so the
   * reason it was refused is still readable next to what replaced it.
   */
  async submit(
    merchantId: string,
    rawInput: unknown,
    actor: MerchantActor,
  ): Promise<MerchantKycDocument> {
    const input: SubmitKycDocumentInput = submitKycDocumentSchema.parse(rawInput);
    await this.loadMerchant(merchantId);

    return runInTransaction(this.db, async (tx) => {
      const live = (
        await tx
          .select()
          .from(k)
          .where(
            and(
              eq(k.merchant_id, merchantId),
              eq(k.doc_type, input.doc_type),
              ne(k.status, 'rejected'),
            ),
          )
          .limit(1)
      )[0];

      if (live?.status === 'approved') {
        throw new MerchantKycAlreadyApprovedError(input.doc_type);
      }

      const row = live
        ? (
            await tx
              .update(k)
              .set({ storage_key: input.storage_key })
              .where(eq(k.id, live.id))
              .returning()
          )[0]
        : (
            await tx
              .insert(k)
              .values({
                merchant_id: merchantId,
                doc_type: input.doc_type,
                storage_key: input.storage_key,
              })
              .returning()
          )[0];
      if (!row) throw new Error('merchant_kyc_documents write returned no row');

      await this.audit.append(tx, {
        entityType: 'merchant',
        entityId: merchantId,
        eventType: live ? 'merchant.kyc_document_replaced' : 'merchant.kyc_document_submitted',
        actorId: actor.actorId,
        actorType: actor.actorType,
        metadata: { doc_type: input.doc_type, document_id: row.id },
      });

      return row;
    });
  }

  // ---------------------------------------------------------------- reviewing

  async approve(
    documentId: string,
    actor: MerchantActor,
  ): Promise<{ document: MerchantKycDocument; status: MerchantKycStatus }> {
    const document = await this.decide(documentId, 'approved', null, actor);
    return { document, status: await this.statusFor(document.merchant_id) };
  }

  /**
   * The other half of a review, and the half that was missing from the Ghana
   * Card flow until #64: a reviewer who opens a document and finds it
   * unreadable, expired or someone else's needs somewhere to say so, or they
   * close the tab and the next reviewer starts from the same blank slate.
   */
  async reject(
    documentId: string,
    rawInput: unknown,
    actor: MerchantActor,
  ): Promise<{ document: MerchantKycDocument; status: MerchantKycStatus }> {
    const input: RejectKycDocumentInput = rejectKycDocumentSchema.parse(rawInput);
    const document = await this.decide(documentId, 'rejected', input.reason, actor);
    return { document, status: await this.statusFor(document.merchant_id) };
  }

  // ------------------------------------------------------------------ helpers

  private async decide(
    documentId: string,
    status: 'approved' | 'rejected',
    reason: string | null,
    actor: MerchantActor,
  ): Promise<MerchantKycDocument> {
    return runInTransaction(this.db, async (tx) => {
      const nowIso = new Date().toISOString();
      // The reviewer is a staff login, so their id is a users.id the column can
      // reference — `actorOf` maps both admin and agent staff to 'admin'. Any
      // other actor is recorded on the audit row only: pointing reviewed_by at
      // a SYSTEM_ACTORS uuid would fail the foreign key.
      const reviewedBy = actor.actorType === 'admin' ? actor.actorId : null;

      const rows = await tx
        .update(k)
        .set({
          status,
          reviewed_at: nowIso,
          reviewed_by: reviewedBy,
          rejection_reason: reason,
        })
        .where(eq(k.id, documentId))
        .returning();
      const row = rows[0];
      if (!row) throw new MerchantKycDocumentNotFoundError(documentId);

      await this.audit.append(tx, {
        entityType: 'merchant',
        entityId: row.merchant_id,
        eventType: status === 'approved' ? 'merchant.kyc_approved' : 'merchant.kyc_rejected',
        toState: status,
        actorId: actor.actorId,
        actorType: actor.actorType,
        reason,
        metadata: { doc_type: row.doc_type, document_id: row.id },
      });

      return row;
    });
  }

  private async loadMerchant(merchantId: string) {
    const rows = await this.db
      .select()
      .from(m)
      .where(and(eq(m.id, merchantId), isNull(m.deleted_at)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new MerchantNotFoundError(merchantId);
    return row;
  }
}
