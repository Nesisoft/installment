import { schema } from '@installment/db';
import type { RecordDecisionInput } from '../applications/dto';
import type { ScoringDecision } from './types';

/** GHS (cedis) → integer pesewas; rounds away float dust. */
function ghsToPesewas(ghs: number): number {
  return Math.round(ghs * 100);
}

/**
 * The first failing rule's reason, or a generic score-threshold message when a
 * decline came from the score band rather than a specific gate.
 */
export function declineReason(decision: ScoringDecision): string {
  const failed = decision.rulesFired.find((r) => !r.passed && r.reason);
  return failed?.reason ?? `Score ${decision.score} below approval threshold`;
}

/** Maps an engine decision onto the application's recordDecision input. */
export function toRecordDecisionInput(decision: ScoringDecision): RecordDecisionInput {
  if (decision.outcome === 'counter_offer') {
    const offer = decision.counterOffer;
    if (!offer) throw new Error('counter_offer decision is missing a counterOffer');
    return {
      outcome: 'counter_offer',
      counter_down_payment_pesewas: ghsToPesewas(offer.downPaymentGhs),
      counter_financed_pesewas: ghsToPesewas(offer.revisedAmountGhs),
    };
  }
  if (decision.outcome === 'declined') {
    return { outcome: 'declined', declined_reason: declineReason(decision) };
  }
  return { outcome: decision.outcome };
}

/** Builds the immutable credit_profiles row from an engine decision. */
export function toCreditProfileValues(
  customerId: string,
  applicationId: string,
  decision: ScoringDecision,
): typeof schema.credit_profiles.$inferInsert {
  return {
    customer_id: customerId,
    application_id: applicationId,
    score: decision.score,
    risk_band: decision.riskBand,
    outcome: decision.outcome,
    approved_limit_pesewas: ghsToPesewas(decision.approvedLimitGhs),
    ruleset_version: decision.rulesetVersion,
    rules_fired: decision.rulesFired,
    features_snapshot: decision.featuresSnapshot,
    decided_at: decision.decidedAt.toISOString(),
  };
}
