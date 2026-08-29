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
 * How much a customer with no history at all may borrow on a first order.
 *
 * Every scoring rule that carries real weight — on-time rate, consecutive
 * payments, Paystack history, account age — is zero by definition on day one,
 * and together they are 450 of the available points. A verified, blameless
 * first-time shopper therefore scores 275, lands in `unscorable`, and is
 * declined. That is not a bug in the rules; it is the absence of a policy for
 * people who have not borrowed before, and without one the marketplace can
 * never approve its own first customer.
 *
 * The cap is on the amount the plan FINANCES, not on what the order costs. The
 * two are different numbers and the difference is the whole exposure: a GHS 400
 * order lends GHS 240 under "Pay in 4" (4000 bps deposit) and the entire GHS 400
 * under "Pay in 4 (weekly)", which takes no deposit at all.
 */
export interface StarterPolicy {
  /**
   * Ceiling on the financed amount, in cedis. This is the most that can be lost
   * to any single customer who takes the goods and never pays — there is no
   * repayment history to have warned us. Zero disables the policy entirely and
   * restores the previous behaviour.
   */
  maxFinancedGhs: number;
}

export const DEFAULT_STARTER_POLICY: StarterPolicy = { maxFinancedGhs: 250 };

/**
 * Three-stage rules engine: hard gates → weighted scoring → exposure checks.
 * Pure: given features (and an optional decision timestamp) it returns a fully
 * explainable, reproducible decision. No I/O — signal collection happens
 * upstream and persistence happens downstream.
 */
export class ScoringEngine {
  constructor(
    private readonly ruleset: Ruleset = DEFAULT_RULESET,
    private readonly starter: StarterPolicy = DEFAULT_STARTER_POLICY,
  ) {}

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

    // Reached only after every gate and exposure rule has passed, so a recent
    // default, a blocklisted customer, too many open plans or an application
    // burst has already returned above and cannot arrive here.
    if (outcome === 'declined' && this.qualifiesForStarter(features)) {
      return {
        outcome: 'approved',
        score: totalScore,
        riskBand: band,
        // This order, not a standing line. A first-time customer has shown us
        // nothing that would justify quoting them a limit to spend against, and
        // a headline number they cannot actually use twice is a promise we did
        // not mean to make.
        approvedLimitGhs: features.request.orderAmountGhs,
        rulesetVersion: this.ruleset.version,
        rulesFired,
        featuresSnapshot: features,
        decidedAt: now,
      };
    }

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

  /**
   * What the plan actually lends: the order less its deposit.
   *
   * A deposit that is missing or not a number is read as zero — the whole order
   * financed — so a malformed template makes the cap stricter rather than
   * letting an unbounded amount through on a silent NaN.
   */
  private financedGhs(f: FeatureVector): number {
    const bps = Number.isFinite(f.request.downPaymentBps) ? f.request.downPaymentBps : 0;
    const depositShare = Math.min(Math.max(bps, 0), 10_000) / 10_000;
    return f.request.orderAmountGhs * (1 - depositShare);
  }

  /**
   * A first-time customer we have nothing against, borrowing little enough that
   * being wrong is survivable.
   *
   * "Thin file" is the load-bearing word: no history is not the same as bad
   * history, and this path exists only for the former. Anyone who has borrowed
   * from us before — well or badly — is scored on that record instead, because
   * the record is better evidence than a starter cap.
   *
   * `priorDefaultsAllTime`, not the twelve-month gate: someone who defaulted
   * eighteen months ago passes `gate.no_recent_default` and, having completed no
   * plans since, would otherwise look identical to a newcomer here.
   *
   * Deliberately NOT `identity.phoneVerified`. That field is a placeholder the
   * collector returns as a constant `false` — nothing captures it on `customers`
   * yet — so requiring it would make this policy unreachable in production while
   * every unit test built its own vector and passed. A rule that can never fire
   * is worse than no rule, because it reads as protection. The substance is
   * covered anyway: customers authenticate by phone OTP and nothing else, so a
   * customer who has ever signed in has proved control of the number, and
   * `gate.phone_age` separately refuses a SIM bought this morning.
   */
  private qualifiesForStarter(f: FeatureVector): boolean {
    if (this.starter.maxFinancedGhs <= 0) return false;
    return (
      f.repayment.completedPlansCount === 0 &&
      f.repayment.priorDefaultsAllTime === 0 &&
      f.exposure.activePlansCount === 0 &&
      f.exposure.outstandingBalanceGhs === 0 &&
      f.identity.ghanaCardVerified &&
      this.financedGhs(f) <= this.starter.maxFinancedGhs
    );
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
