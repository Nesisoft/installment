// ============================================================================
// scoring-engine.ts
// ----------------------------------------------------------------------------
// Rules-based credit scoring engine for the Installment platform.
//
// Design goals:
//   1. Rules are DATA, not code — iterate without deploying
//   2. Every decision is fully explainable (which rules fired, which signals)
//   3. Snapshot the feature vector + rule version on every decision (audit)
//   4. Signal collectors are independent + fail-soft (one source down ≠ outage)
//   5. Decisions are reproducible: same features + same rules version = same result
// ============================================================================

// ---------------------------------------------------------------------------
// 1. FEATURE VECTOR — the typed object every rule receives
// ---------------------------------------------------------------------------

export interface FeatureVector {
  identity: {
    ghanaCardVerified: boolean;
    phoneVerified: boolean;
    phoneAgeDays: number;
    addressProofUploaded: boolean;
    kycTier: 0 | 1 | 2;
    ageYears: number | null;
  };
  repayment: {
    completedPlansCount: number;
    onTimePaymentRate: number;       // 0..1
    averageDaysPastDue: number;
    priorDefaults12mo: number;
    priorDefaultsAllTime: number;
    consecutiveOnTime: number;
  };
  behavior: {
    paystackTransactionCount: number;
    momoTransactionShare: number;    // 0..1
    averageTransactionGhs: number;
    failedChargeRate90d: number;     // 0..1
  };
  tenure: {
    accountAgeDays: number;
    loginsLast30Days: number;
    deviceFingerprintKnown: boolean;
    distinctDevicesLast90Days: number;
  };
  employment: {
    employerLinked: boolean;
    salaryBand: 'unknown' | 'low' | 'mid' | 'high';
    employmentMonths: number | null;
    payrollDeductionConsent: boolean;
  };
  exposure: {
    activePlansCount: number;
    outstandingBalanceGhs: number;
    currentLimitGhs: number;
    applicationsLast24h: number;
    isOnBlocklist: boolean;
  };
  request: {
    orderAmountGhs: number;
    merchantCategory: string;
    planTemplateId: string;
    planMinGhs: number;
    planMaxGhs: number;
  };
}

// ---------------------------------------------------------------------------
// 2. DECISION OUTPUT — what every score() call returns
// ---------------------------------------------------------------------------

export type DecisionOutcome =
  | 'approved'
  | 'approved_tier_2'
  | 'counter_offer'
  | 'manual_review'
  | 'declined';

export interface RuleResult {
  ruleId: string;
  category: 'hard_gate' | 'score' | 'exposure';
  passed: boolean;
  points: number;          // contribution to total score (0 for gates)
  reason?: string;         // populated when fails or fires
}

export interface ScoringDecision {
  outcome: DecisionOutcome;
  score: number;                // 0..1000
  riskBand: 'prime' | 'near_prime' | 'subprime' | 'unscorable';
  approvedLimitGhs: number;
  counterOffer?: {
    downPaymentGhs: number;
    revisedAmountGhs: number;
    revisedTermMonths: number;
  };
  rulesetVersion: string;
  rulesFired: RuleResult[];
  featuresSnapshot: FeatureVector;
  decidedAt: Date;
}

// ---------------------------------------------------------------------------
// 3. RULE DEFINITION — the canonical shape of every rule
// ---------------------------------------------------------------------------

export interface Rule {
  id: string;
  category: 'hard_gate' | 'score' | 'exposure';
  description: string;
  /** Pure predicate over the feature vector */
  evaluate: (f: FeatureVector) => { passed: boolean; points: number; reason?: string };
}

// ---------------------------------------------------------------------------
// 4. THE RULESET — data, not branching logic
//    Stored alongside the code for clarity here; in production, loaded
//    from the database so admins can adjust weights without deploys.
// ---------------------------------------------------------------------------

export const RULESET_VERSION = 'v1.0.0';

export const HARD_GATES: Rule[] = [
  {
    id: 'gate.ghana_card_verified',
    category: 'hard_gate',
    description: 'Ghana Card must be verified',
    evaluate: (f) => ({
      passed: f.identity.ghanaCardVerified,
      points: 0,
      reason: f.identity.ghanaCardVerified ? undefined : 'Ghana Card not verified',
    }),
  },
  {
    id: 'gate.phone_age',
    category: 'hard_gate',
    description: 'Phone number must be at least 30 days old',
    evaluate: (f) => ({
      passed: f.identity.phoneAgeDays >= 30,
      points: 0,
      reason: f.identity.phoneAgeDays < 30 ? 'Phone number too new' : undefined,
    }),
  },
  {
    id: 'gate.no_recent_default',
    category: 'hard_gate',
    description: 'No defaults in the last 12 months',
    evaluate: (f) => ({
      passed: f.repayment.priorDefaults12mo === 0,
      points: 0,
      reason: f.repayment.priorDefaults12mo > 0 ? 'Recent default on file' : undefined,
    }),
  },
  {
    id: 'gate.amount_in_range',
    category: 'hard_gate',
    description: 'Order amount within plan template bounds',
    evaluate: (f) => {
      const ok =
        f.request.orderAmountGhs >= f.request.planMinGhs &&
        f.request.orderAmountGhs <= f.request.planMaxGhs;
      return {
        passed: ok,
        points: 0,
        reason: ok ? undefined : 'Amount outside plan limits',
      };
    },
  },
  {
    id: 'gate.not_blocklisted',
    category: 'hard_gate',
    description: 'Customer not on internal blocklist',
    evaluate: (f) => ({
      passed: !f.exposure.isOnBlocklist,
      points: 0,
      reason: f.exposure.isOnBlocklist ? 'Customer blocked' : undefined,
    }),
  },
  {
    id: 'gate.age_range',
    category: 'hard_gate',
    description: 'Age 18–70',
    evaluate: (f) => {
      const age = f.identity.ageYears;
      const ok = age !== null && age >= 18 && age <= 70;
      return {
        passed: ok,
        points: 0,
        reason: ok ? undefined : 'Age out of range or unknown',
      };
    },
  },
];

export const SCORING_RULES: Rule[] = [
  // ─── Repayment history (40% = up to 400 points) ───
  {
    id: 'score.on_time_rate',
    category: 'score',
    description: 'Award points for on-time payment rate',
    evaluate: (f) => {
      const rate = f.repayment.onTimePaymentRate;
      const plans = f.repayment.completedPlansCount;
      // No history → 0; needs at least 2 plans to count fully
      if (plans === 0) return { passed: true, points: 0 };
      const dampener = Math.min(plans / 3, 1); // ramp up over first 3 plans
      const points = Math.round(250 * rate * dampener);
      return { passed: true, points };
    },
  },
  {
    id: 'score.consecutive_on_time',
    category: 'score',
    description: 'Bonus for streak of on-time payments',
    evaluate: (f) => {
      const streak = f.repayment.consecutiveOnTime;
      const points = Math.min(streak * 10, 100); // capped at 100
      return { passed: true, points };
    },
  },
  {
    id: 'score.no_prior_defaults',
    category: 'score',
    description: 'Clean record (lifetime) bonus',
    evaluate: (f) => ({
      passed: true,
      points: f.repayment.priorDefaultsAllTime === 0 ? 50 : 0,
    }),
  },

  // ─── Payment behavior (20% = up to 200 points) ───
  {
    id: 'score.paystack_history',
    category: 'score',
    description: 'Established Paystack transaction history',
    evaluate: (f) => {
      const count = f.behavior.paystackTransactionCount;
      // Logarithmic scale, capped
      const points = Math.min(Math.round(Math.log2(count + 1) * 25), 100);
      return { passed: true, points };
    },
  },
  {
    id: 'score.low_failure_rate',
    category: 'score',
    description: 'Penalize high failed-charge rate',
    evaluate: (f) => {
      const rate = f.behavior.failedChargeRate90d;
      if (rate > 0.3) return { passed: true, points: -50, reason: 'High recent failure rate' };
      if (rate < 0.05) return { passed: true, points: 50 };
      return { passed: true, points: 25 };
    },
  },
  {
    id: 'score.payment_diversity',
    category: 'score',
    description: 'Multiple payment methods available',
    evaluate: (f) => {
      // Customers who use both MoMo and card have more fallback options
      const balanced = f.behavior.momoTransactionShare > 0.2 &&
                       f.behavior.momoTransactionShare < 0.8;
      return { passed: true, points: balanced ? 50 : 25 };
    },
  },

  // ─── Tenure / engagement (15% = up to 150 points) ───
  {
    id: 'score.account_age',
    category: 'score',
    description: 'Account age in days',
    evaluate: (f) => {
      const days = f.tenure.accountAgeDays;
      if (days >= 365) return { passed: true, points: 100 };
      if (days >= 180) return { passed: true, points: 70 };
      if (days >= 90) return { passed: true, points: 40 };
      if (days >= 30) return { passed: true, points: 20 };
      return { passed: true, points: 0 };
    },
  },
  {
    id: 'score.device_stability',
    category: 'score',
    description: 'Stable device fingerprint',
    evaluate: (f) => {
      if (!f.tenure.deviceFingerprintKnown) return { passed: true, points: 0 };
      if (f.tenure.distinctDevicesLast90Days > 3) {
        return { passed: true, points: 0, reason: 'Many devices in 90d' };
      }
      return { passed: true, points: 50 };
    },
  },

  // ─── Employment / payroll (15% = up to 150 points) ───
  {
    id: 'score.employer_linked',
    category: 'score',
    description: 'Verified employer linkage',
    evaluate: (f) => {
      if (!f.employment.employerLinked) return { passed: true, points: 0 };
      const base = 75;
      const consent = f.employment.payrollDeductionConsent ? 50 : 0;
      const tenureBonus = (f.employment.employmentMonths ?? 0) >= 12 ? 25 : 0;
      return { passed: true, points: base + consent + tenureBonus };
    },
  },

  // ─── Identity completeness (10% = up to 100 points) ───
  {
    id: 'score.kyc_tier',
    category: 'score',
    description: 'Higher KYC tier = more trust',
    evaluate: (f) => ({
      passed: true,
      points: f.identity.kycTier === 2 ? 100 : f.identity.kycTier === 1 ? 50 : 0,
    }),
  },
];

export const EXPOSURE_RULES: Rule[] = [
  {
    id: 'exposure.max_concurrent',
    category: 'exposure',
    description: 'Maximum concurrent active plans',
    evaluate: (f) => ({
      passed: f.exposure.activePlansCount < 3,
      points: 0,
      reason: f.exposure.activePlansCount >= 3 ? 'Too many active plans' : undefined,
    }),
  },
  {
    id: 'exposure.velocity',
    category: 'exposure',
    description: 'Velocity check — too many applications recently',
    evaluate: (f) => ({
      passed: f.exposure.applicationsLast24h < 5,
      points: 0,
      reason: f.exposure.applicationsLast24h >= 5 ? 'Velocity limit hit' : undefined,
    }),
  },
  // Note: Limit calculation is handled outside rules — see computeLimit below
];

// ---------------------------------------------------------------------------
// 5. THE ENGINE — orchestrates evaluation, scoring, and decisioning
// ---------------------------------------------------------------------------

import { Injectable } from '@nestjs/common';

@Injectable()
export class ScoringEngine {
  /**
   * Pure scoring — given features, return a decision.
   * No I/O, no DB writes. Signal collection happens upstream.
   */
  score(features: FeatureVector): ScoringDecision {
    const rulesFired: RuleResult[] = [];

    // ─── Stage 1: Hard gates ───
    for (const gate of HARD_GATES) {
      const r = gate.evaluate(features);
      rulesFired.push({ ruleId: gate.id, category: 'hard_gate', ...r });

      if (!r.passed) {
        return this.declineDecision(features, rulesFired);
      }
    }

    // ─── Stage 2: Weighted scoring ───
    let totalScore = 0;
    for (const rule of SCORING_RULES) {
      const r = rule.evaluate(features);
      rulesFired.push({ ruleId: rule.id, category: 'score', ...r });
      totalScore += r.points;
    }
    totalScore = Math.max(0, Math.min(totalScore, 1000));

    // ─── Stage 3: Exposure & affordability ───
    for (const rule of EXPOSURE_RULES) {
      const r = rule.evaluate(features);
      rulesFired.push({ ruleId: rule.id, category: 'exposure', ...r });

      if (!r.passed) {
        return this.declineDecision(features, rulesFired);
      }
    }

    // ─── Determine band and outcome ───
    const band = this.bandFromScore(totalScore);
    const limit = this.computeLimit(band, features);

    const outcome = this.outcomeFor(totalScore, band, limit, features);

    return {
      outcome,
      score: totalScore,
      riskBand: band,
      approvedLimitGhs: limit,
      counterOffer:
        outcome === 'counter_offer' ? this.buildCounterOffer(features, limit) : undefined,
      rulesetVersion: RULESET_VERSION,
      rulesFired,
      featuresSnapshot: features,
      decidedAt: new Date(),
    };
  }

  private bandFromScore(s: number): ScoringDecision['riskBand'] {
    if (s >= 700) return 'prime';
    if (s >= 500) return 'near_prime';
    if (s >= 350) return 'subprime';
    return 'unscorable';
  }

  private computeLimit(
    band: ScoringDecision['riskBand'],
    f: FeatureVector,
  ): number {
    const baseLimit = {
      prime: 5000,
      near_prime: 2500,
      subprime: 1000,
      unscorable: 0,
    }[band];

    // Payroll consent unlocks a higher cap
    const employmentMultiplier = f.employment.payrollDeductionConsent ? 2 : 1;

    const grossLimit = baseLimit * employmentMultiplier;
    const headroom = grossLimit - f.exposure.outstandingBalanceGhs;
    return Math.max(0, headroom);
  }

  private outcomeFor(
    score: number,
    band: ScoringDecision['riskBand'],
    limit: number,
    f: FeatureVector,
  ): DecisionOutcome {
    if (band === 'unscorable') return 'declined';

    const orderFits = f.request.orderAmountGhs <= limit;

    if (band === 'prime' && orderFits) return 'approved';
    if (band === 'near_prime' && orderFits) return 'approved_tier_2';

    // Order exceeds limit → counter-offer if we can reasonably restructure
    if (!orderFits && limit > 0 && limit >= f.request.orderAmountGhs * 0.5) {
      return 'counter_offer';
    }

    // First-time customer with high-value order → human review
    if (f.repayment.completedPlansCount === 0 && f.request.orderAmountGhs >= 2000) {
      return 'manual_review';
    }

    if (band === 'subprime') return 'manual_review';

    return 'declined';
  }

  private buildCounterOffer(f: FeatureVector, limit: number) {
    // Bump down payment so the financed portion fits the limit
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
  ): ScoringDecision {
    return {
      outcome: 'declined',
      score: 0,
      riskBand: 'unscorable',
      approvedLimitGhs: 0,
      rulesetVersion: RULESET_VERSION,
      rulesFired,
      featuresSnapshot: features,
      decidedAt: new Date(),
    };
  }
}

// ---------------------------------------------------------------------------
// 6. PERSISTENCE — every decision is snapshotted
// ---------------------------------------------------------------------------

/*
@Injectable()
export class ScoringService {
  constructor(
    private readonly collector: FeatureCollectorService,
    private readonly engine: ScoringEngine,
    private readonly db: DrizzleDb,
  ) {}

  async scoreApplication(applicationId: string): Promise<ScoringDecision> {
    const application = await this.db.query.applications.findFirst({
      where: (a, { eq }) => eq(a.id, applicationId),
    });
    if (!application) throw new Error('Application not found');

    const features = await this.collector.collect(application);
    const decision = this.engine.score(features);

    // Immutable snapshot — never updated, only inserted
    await this.db.insert(creditProfiles).values({
      id: randomUUID(),
      customerId: application.customerId,
      applicationId,
      score: decision.score,
      riskBand: decision.riskBand,
      outcome: decision.outcome,
      approvedLimitGhs: decision.approvedLimitGhs,
      rulesetVersion: decision.rulesetVersion,
      rulesFired: decision.rulesFired,
      features: decision.featuresSnapshot,
      decidedAt: decision.decidedAt,
    });

    return decision;
  }
}
*/

// ---------------------------------------------------------------------------
// 7. SIGNAL COLLECTOR PATTERN — fail-soft, cached, parallel
// ---------------------------------------------------------------------------

/*
@Injectable()
export class FeatureCollectorService {
  constructor(
    private readonly identity: IdentityCollector,
    private readonly repayment: RepaymentCollector,
    private readonly behavior: BehaviorCollector,
    private readonly tenure: TenureCollector,
    private readonly employment: EmploymentCollector,
    private readonly exposure: ExposureCollector,
    private readonly cache: RedisCache,
  ) {}

  async collect(application: Application): Promise<FeatureVector> {
    const cacheKey = `features:${application.customerId}`;
    const cached = await this.cache.get<FeatureVector>(cacheKey);
    if (cached) return this.applyRequestFields(cached, application);

    // Parallel + fail-soft: each collector returns a default-shaped object
    // if its upstream is down. Never blocks the application on transient errors.
    const [identity, repayment, behavior, tenure, employment, exposure] =
      await Promise.all([
        this.identity.collect(application.customerId).catch(this.identity.defaults),
        this.repayment.collect(application.customerId).catch(this.repayment.defaults),
        this.behavior.collect(application.customerId).catch(this.behavior.defaults),
        this.tenure.collect(application.customerId).catch(this.tenure.defaults),
        this.employment.collect(application.customerId).catch(this.employment.defaults),
        this.exposure.collect(application.customerId).catch(this.exposure.defaults),
      ]);

    const vector: FeatureVector = {
      identity, repayment, behavior, tenure, employment, exposure,
      request: {
        orderAmountGhs: application.amountGhs,
        merchantCategory: application.merchantCategory,
        planTemplateId: application.planTemplateId,
        planMinGhs: application.planMinGhs,
        planMaxGhs: application.planMaxGhs,
      },
    };

    // Cache feature signals (not request) for 5 minutes
    await this.cache.set(cacheKey, this.stripRequest(vector), 300);
    return vector;
  }
}
*/
