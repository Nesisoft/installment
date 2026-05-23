import type { Rule, Ruleset } from './types';

/**
 * The built-in ruleset (ported verbatim from docs/design/scoring-engine.ts).
 * In production a Ruleset can instead be assembled from the rule_definitions
 * table for hot-reload — ScoringEngine accepts one via its constructor.
 */
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
      return { passed: ok, points: 0, reason: ok ? undefined : 'Amount outside plan limits' };
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
      return { passed: ok, points: 0, reason: ok ? undefined : 'Age out of range or unknown' };
    },
  },
];

export const SCORING_RULES: Rule[] = [
  // ─── Repayment history (up to ~400 points) ───
  {
    id: 'score.on_time_rate',
    category: 'score',
    description: 'Award points for on-time payment rate',
    evaluate: (f) => {
      const rate = f.repayment.onTimePaymentRate;
      const plans = f.repayment.completedPlansCount;
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
      const points = Math.min(f.repayment.consecutiveOnTime * 10, 100); // capped at 100
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

  // ─── Payment behavior (up to ~200 points) ───
  {
    id: 'score.paystack_history',
    category: 'score',
    description: 'Established Paystack transaction history',
    evaluate: (f) => {
      const count = f.behavior.paystackTransactionCount;
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
      const balanced =
        f.behavior.momoTransactionShare > 0.2 && f.behavior.momoTransactionShare < 0.8;
      return { passed: true, points: balanced ? 50 : 25 };
    },
  },

  // ─── Tenure / engagement (up to ~150 points) ───
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

  // ─── Employment / payroll (up to ~150 points) ───
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

  // ─── Identity completeness (up to 100 points) ───
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
];

export const DEFAULT_RULESET: Ruleset = {
  version: RULESET_VERSION,
  hardGates: HARD_GATES,
  scoringRules: SCORING_RULES,
  exposureRules: EXPOSURE_RULES,
};
