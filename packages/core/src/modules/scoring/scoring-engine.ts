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
 * How much a customer with no record with us may be lent on a first order.
 *
 * Nothing in this engine reads a credit bureau. Every signal comes from our own
 * tables — plans they finished, instalments they paid on time, charges we
 * collected, how long they have been a customer — so the score is precisely
 * "how well have they repaid US", and it has nothing to say about somebody who
 * has not bought from us yet.
 *
 * That is the right model with a missing entry point. Every rule carrying real
 * weight — on-time rate, consecutive payments, charges collected, account age —
 * is zero by definition on day one, and together they are 450 of the available
 * points. A verified, blameless first-time shopper therefore scores 275, lands
 * in `unscorable`, and is declined; without a policy for people who have not
 * bought from us before, the marketplace can never approve its own first
 * customer.
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
  /**
   * The ceiling when a **verified** link to an **active** employer exists.
   *
   * Employment is not repayment history and this does not pretend it is. What
   * it is, is the one thing about a first-time customer that someone outside
   * this company has confirmed: they hold a job at an employer we have a
   * partnership with, and both halves were checked rather than typed. That is
   * worth more headroom than a bare verified Ghana Card, and less than a plan
   * they have actually finished paying.
   */
  maxFinancedWithEmployerGhs: number;
  /**
   * The ceiling when that link also carries payroll-deduction consent.
   *
   * The step up is larger here than between the first two tiers, because this
   * is the only tier where repayment does not depend on the customer choosing
   * to pay: the employer remits from salary before it reaches them. It is the
   * closest thing to collateral in the whole model, which is also why it needs
   * the verified link underneath it — consent recorded against an unchecked
   * employer collects nothing.
   */
  maxFinancedWithPayrollGhs: number;
}

/**
 * The three tiers a first order can sit in. These are policy, not arithmetic:
 * they say how much this marketplace is willing to lose on a customer it knows
 * nothing about yet, given what someone else has confirmed about them.
 */
export const DEFAULT_STARTER_POLICY: StarterPolicy = {
  maxFinancedGhs: 250,
  maxFinancedWithEmployerGhs: 750,
  maxFinancedWithPayrollGhs: 2_000,
};

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
    //
    // `manual_review` as well as `declined`, because which of the two a thin
    // file lands on is an accident of where the score fell, not a judgement
    // anybody made. Measured against real rows: a blameless newcomer with
    // nothing but a verified card scores 225, lands `unscorable` and is
    // declined; give the same person a live employer link and the linkage rule
    // adds 150, which clears the 350 floor into `subprime` and sends them to a
    // human instead. Both are "we have no history here", and the financed
    // ceiling below — not the band — is what decides whether that is
    // affordable.
    if (
      (outcome === 'declined' || outcome === 'manual_review') &&
      this.qualifiesForStarter(features)
    ) {
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
    const ceiling = this.starterCeilingGhs(f);
    if (ceiling <= 0) return false;
    return (
      f.repayment.completedPlansCount === 0 &&
      f.repayment.priorDefaultsAllTime === 0 &&
      f.exposure.activePlansCount === 0 &&
      f.exposure.outstandingBalanceGhs === 0 &&
      f.identity.ghanaCardVerified &&
      this.financedGhs(f) <= ceiling
    );
  }

  /**
   * How much this particular first-timer may finance.
   *
   * Graduated by who has vouched for them, and by how the money would actually
   * come back:
   *
   *   card only                        → we are trusting them
   *   + verified link to a live employer → someone outside confirmed the job
   *   + payroll-deduction consent        → the salary pays us before they do
   *
   * `employerVerified` and not `employerLinked`: a link is created by an
   * operator typing an employee number and lands `active` the moment it is
   * saved, so lending against the bare link would be lending against data
   * entry. Verification is a separate, deliberate act
   * (`customer_employment.verified_at`), and the collector also requires the
   * employer itself to be active — a link to a terminated employer records
   * where somebody used to work.
   *
   * The base tier is checked last so `maxFinancedGhs: 0` still disables the
   * policy outright, as its documentation promises.
   */
  private starterCeilingGhs(f: FeatureVector): number {
    if (this.starter.maxFinancedGhs <= 0) return 0;
    if (!f.employment.employerLinked || !f.employment.employerVerified) {
      return this.starter.maxFinancedGhs;
    }
    const tier = f.employment.payrollDeductionConsent
      ? this.starter.maxFinancedWithPayrollGhs
      : this.starter.maxFinancedWithEmployerGhs;
    // Never below the base tier: a policy that made an employed customer worse
    // off than an unemployed one would be a misconfiguration, not a decision.
    return Math.max(tier, this.starter.maxFinancedGhs);
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

    /**
     * Someone who has finished a plan with us and never defaulted is not a thin
     * file, whatever band the score puts them in — and `limit` already IS our
     * appetite for that band, so an order inside it does not need a human to
     * agree a second time.
     *
     * Without this, paying us back perfectly made the SECOND purchase harder
     * than the first: the starter limit approves order one, then a customer with
     * one completed plan sits at ~458 — subprime — and order two went to manual
     * review, until the score climbed past 500 on the third. Approved, reviewed,
     * approved, at exactly the moment a satisfied first-time buyer comes back.
     */
    if (band === 'subprime' && orderFits && this.hasProvenRepayment(f)) {
      return 'approved_tier_2';
    }

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

  /**
   * They have completed at least one plan and have never defaulted on us.
   *
   * `priorDefaultsAllTime`, not the twelve-month gate — a default from two years
   * ago is still the strongest thing we know about them, and the gate that lets
   * it through is about recency, not forgiveness.
   *
   * Note what this does NOT re-check: whether they paid on time. That is already
   * priced into the band, through `score.on_time_rate` and
   * `score.consecutive_on_time`. Someone who completed a plan paying every
   * instalment late scores below the subprime floor and is declined before
   * reaching here, so checking it again would be counting it twice.
   */
  private hasProvenRepayment(f: FeatureVector): boolean {
    return f.repayment.completedPlansCount >= 1 && f.repayment.priorDefaultsAllTime === 0;
  }

  /**
   * A smaller loan on the same order: more down, less financed.
   *
   * The third term is the one that was missing. `limit` and `orderAmountGhs`
   * are both measured on the order, while the money at risk is what the plan
   * FINANCES — so on a deposit-taking template the arithmetic could counter a
   * request with something riskier than the request. A GHS 1,400 order on a
   * 50%-deposit plan finances GHS 700; the old two-term minimum answered it
   * with GHS 980 financed and GHS 420 down, cutting the customer's deposit to
   * "restructure" an order it had judged too large. A counter-offer may only
   * ever reduce our exposure.
   */
  private buildCounterOffer(f: FeatureVector, limit: number): CounterOffer {
    const financed = Math.min(limit, f.request.orderAmountGhs * 0.7, this.financedGhs(f));
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
