import type { Database } from '@installment/db';
import { AuditLogger } from '../../modules/audit/audit-logger.service';
import { CustomersService, type CustomerActor } from '../../modules/customers/customers.service';
import { MockGhanaCardVerifier } from '../../modules/customers/ghana-card-verifier';
import { SYSTEM_ACTORS } from '../constants/system-actors';

/**
 * Give a customer a verified Ghana Card, the way production would.
 *
 * Fixtures used to write `{ ghana_card_verified: true, kyc_tier: 2 }` straight
 * onto the row, and two things followed from that.
 *
 * The first is that 0019's CHECK now refuses it: `ghana_card_verified` has to
 * agree with `ghana_card_status`, and a verified card needs a card.
 *
 * The second is worse, and is why this helper drives the real service instead
 * of just adding the missing columns. **`kyc_tier: 2` is not a state this
 * system can produce.** `verifyGhanaCard` raises the tier to 1 and nothing
 * anywhere raises it to 2, so `score.kyc_tier`'s 100-point band was only ever
 * reachable by a fixture asserting it into existence — including the arithmetic
 * in PLATFORM-ROADMAP.md, which counts "KYC tier 2 100" toward a first-timer's
 * ceiling of 325. The real ceiling is 50 lower. Going through the service means
 * a fixture cannot claim a tier the product cannot grant.
 */
export async function approveGhanaCard(
  db: Database,
  customerId: string,
  actor: CustomerActor = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' },
  audit: AuditLogger = new AuditLogger(),
): Promise<void> {
  const customers = new CustomersService(db, audit, new MockGhanaCardVerifier());
  await customers.attachGhanaCard(
    customerId,
    {
      ghana_card_number: `GHA-${String(Math.floor(100_000_000 + Math.random() * 899_999_999))}-0`,
      ghana_card_image_key: `private/kyc/${customerId}/fixture-ghana-card.jpg`,
    },
    actor,
  );
  await customers.verifyGhanaCard(customerId, actor);
}
