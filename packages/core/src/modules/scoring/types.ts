/**
 * Scoring engine types — ported from docs/design/scoring-engine.ts.
 *
 * Design invariants (DEVELOPMENT-PLAN.md §4 Phase 4):
 *   * Rules are DATA, not branching logic — iterable without deploys.
 *   * Every decision is explainable: which rules fired, with what points.
 *   * Decisions are reproducible: same features + same ruleset version →
 *     identical score / outcome / rulesFired.
 */

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
    onTimePaymentRate: number; // 0..1
    averageDaysPastDue: number;
    priorDefaults12mo: number;
    priorDefaultsAllTime: number;
    consecutiveOnTime: number;
  };
  behavior: {
    paystackTransactionCount: number;
    momoTransactionShare: number; // 0..1
    averageTransactionGhs: number;
    failedChargeRate90d: number; // 0..1
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
    /**
     * The chosen plan's deposit, in basis points. Carried because the money at
     * risk is what the plan *finances*, not what the order costs: at 4000 bps a
     * GHS 400 order lends GHS 240, and at 0 bps the same order lends the whole
     * GHS 400. A policy capped on the order amount would quietly take two-thirds
     * more exposure on the zero-deposit template.
     */
    downPaymentBps: number;
  };
}

export type DecisionOutcome =
  | 'approved'
  | 'approved_tier_2'
  | 'counter_offer'
  | 'manual_review'
  | 'declined';

export type RiskBand = 'prime' | 'near_prime' | 'subprime' | 'unscorable';

export type RuleCategory = 'hard_gate' | 'score' | 'exposure';

export interface RuleResult {
  ruleId: string;
  category: RuleCategory;
  passed: boolean;
  points: number; // contribution to total score (0 for gates)
  reason?: string; // populated when a rule fails or fires
}

export interface CounterOffer {
  downPaymentGhs: number;
  revisedAmountGhs: number;
  revisedTermMonths: number;
}

export interface ScoringDecision {
  outcome: DecisionOutcome;
  score: number; // 0..1000
  riskBand: RiskBand;
  approvedLimitGhs: number;
  counterOffer?: CounterOffer;
  rulesetVersion: string;
  rulesFired: RuleResult[];
  featuresSnapshot: FeatureVector;
  decidedAt: Date;
}

export interface Rule {
  id: string;
  category: RuleCategory;
  description: string;
  /** Pure predicate over the feature vector. */
  evaluate: (f: FeatureVector) => { passed: boolean; points: number; reason?: string };
}

export interface Ruleset {
  version: string;
  hardGates: Rule[];
  scoringRules: Rule[];
  exposureRules: Rule[];
}
