import { DEFAULT_RULESET } from './ruleset';
import type {
  CounterOffer,
  DecisionOutcome,
  FeatureVector,
  RiskBand,
  RuleResult,
  Ruleset,
  ScoringDecision,
} from './types';

/**
 * Three-stage rules engine: hard gates → weighted scoring → exposure checks.
 * Pure: given features (and an optional decision timestamp) it returns a fully
 * explainable, reproducible decision. No I/O — signal collection happens
 * upstream and persistence happens downstream.
 */
export class ScoringEngine {
  constructor(private readonly ruleset: Ruleset = DEFAULT_RULESET) {}

  score(features: FeatureVector, now: Date = new Date()): ScoringDecision {
    const rulesFired: RuleResult[] = [];

    // ─── Stage 1: Hard gates ───
    for (const gate of this.ruleset.hardGates) {
      const r = gate.evaluate(features);
      rulesFired.push({ ruleId: gate.id, category: 'hard_gate', ...r });
      if (!r.passed) return this.declineDecision(features, rulesFired, now);
    }

    // ─── Stage 2: Weighted scoring ───
    let totalScore = 0;
    for (const rule of this.ruleset.scoringRules) {
      const r = rule.evaluate(features);
      rulesFired.push({ ruleId: rule.id, category: 'score', ...r });
      totalScore += r.points;
    }
    totalScore = Math.max(0, Math.min(totalScore, 1000));

    // ─── Stage 3: Exposure & affordability ───
    for (const rule of this.ruleset.exposureRules) {
      const r = rule.evaluate(features);
      rulesFired.push({ ruleId: rule.id, category: 'exposure', ...r });
      if (!r.passed) return this.declineDecision(features, rulesFired, now);
    }

    const band = this.bandFromScore(totalScore);
    const limit = this.computeLimit(band, features);
    const outcome = this.outcomeFor(band, limit, features);

    return {
      outcome,
      score: totalScore,
      riskBand: band,
      approvedLimitGhs: limit,
      counterOffer:
        outcome === 'counter_offer' ? this.buildCounterOffer(features, limit) : undefined,
      rulesetVersion: this.ruleset.version,
      rulesFired,
      featuresSnapshot: features,
      decidedAt: now,
    };
  }

  private bandFromScore(s: number): RiskBand {
    if (s >= 700) return 'prime';
    if (s >= 500) return 'near_prime';
    if (s >= 350) return 'subprime';
    return 'unscorable';
  }

  private computeLimit(band: RiskBand, f: FeatureVector): number {
    const baseLimit = { prime: 5000, near_prime: 2500, subprime: 1000, unscorable: 0 }[band];
    const employmentMultiplier = f.employment.payrollDeductionConsent ? 2 : 1;
    const grossLimit = baseLimit * employmentMultiplier;
    const headroom = grossLimit - f.exposure.outstandingBalanceGhs;
    return Math.max(0, headroom);
  }

  private outcomeFor(band: RiskBand, limit: number, f: FeatureVector): DecisionOutcome {
    if (band === 'unscorable') return 'declined';

    const orderFits = f.request.orderAmountGhs <= limit;
    if (band === 'prime' && orderFits) return 'approved';
    if (band === 'near_prime' && orderFits) return 'approved_tier_2';

    // Order exceeds limit → counter-offer if we can reasonably restructure.
    if (!orderFits && limit > 0 && limit >= f.request.orderAmountGhs * 0.5) {
      return 'counter_offer';
    }

    // First-time customer with a high-value order → human review.
    if (f.repayment.completedPlansCount === 0 && f.request.orderAmountGhs >= 2000) {
      return 'manual_review';
    }

    if (band === 'subprime') return 'manual_review';
    return 'declined';
  }

  private buildCounterOffer(f: FeatureVector, limit: number): CounterOffer {
    const financed = Math.min(limit, f.request.orderAmountGhs * 0.7);
    const downPayment = f.request.orderAmountGhs - financed;
    return {
      downPaymentGhs: Math.round(downPayment),
      revisedAmountGhs: Math.round(financed),
      revisedTermMonths: 3,
    };
  }

  private declineDecision(
    features: FeatureVector,
    rulesFired: RuleResult[],
    now: Date,
  ): ScoringDecision {
    return {
      outcome: 'declined',
      score: 0,
      riskBand: 'unscorable',
      approvedLimitGhs: 0,
      rulesetVersion: this.ruleset.version,
      rulesFired,
      featuresSnapshot: features,
      decidedAt: now,
    };
  }
}
