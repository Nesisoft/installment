import type { Database } from '@installment/db';
import { AuditLogger } from '../../modules/audit/audit-logger.service';
import {
  MerchantKycService,
  REQUIRED_MERCHANT_KYC_DOCS,
} from '../../modules/merchants/merchant-kyc.service';
import { SYSTEM_ACTORS } from '../constants/system-actors';
import type { MerchantActor } from '../../modules/merchants/merchants.service';

/**
 * Make a merchant activatable: submit and approve everything KYC requires.
 *
 * A merchant's first activation is refused until the required documents are
 * approved, which is the point — but that leaves a pile of fixtures across core
 * and commerce whose subject is checkout, fulfilment or catalogue scope and
 * which only need an active seller to exist. Every one of them writing the same
 * three submit-and-approve pairs by hand is how a fixture drifts from the
 * requirement list it is meant to satisfy.
 *
 * Driven through the real service rather than inserting rows, so a change to
 * the requirements — a fourth document, a different name — reaches every caller
 * without anybody editing them.
 */
export async function approveRequiredMerchantKyc(
  db: Database,
  merchantId: string,
  actor: MerchantActor = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' },
  audit: AuditLogger = new AuditLogger(),
): Promise<void> {
  const kyc = new MerchantKycService(db, audit);
  for (const doc_type of REQUIRED_MERCHANT_KYC_DOCS) {
    const document = await kyc.submit(
      merchantId,
      {
        doc_type,
        storage_key: `private/merchant-kyc/${merchantId}/fixture-${doc_type}.jpg`,
      },
      actor,
    );
    await kyc.approve(document.id, actor);
  }
}
