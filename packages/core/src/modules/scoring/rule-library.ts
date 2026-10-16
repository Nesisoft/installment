import type { Rule, RuleCategory } from './types';

/**
 * The library of rule *logic*, parameterised by configuration. Rule predicates
 * live in code (never executed from the DB) while their tunable numbers —
 * thresholds, weights, caps — come from configuration. The built-in
 * DEFAULT_RULESET is assembled from these blueprints with their defaultConfig,
 * and {@link RulesetLoader} rebuilds them from rule_definitions rows so ops can
 * adjust weights or toggle rules without a deploy.
 */
type EvaluateFn = Rule['evaluate'];

export interface RuleBlueprint {
  readonly id: string;
  readonly category: RuleCategory;
  readonly description: string;
  readonly defaultConfig: Record<string, unknown>;
  /** Builds the evaluator, layering `config` over the blueprint defaults. */
  build(config?: Record<string, unknown>): EvaluateFn;
}

interface RuleSpec<C extends object> {
  id: string;
  category: RuleCategory;
  description: string;
  defaultConfig: C;
  build: (config: C) => EvaluateFn;
}

function defineRule<C extends object>(spec: RuleSpec<C>): RuleBlueprint {
  return {
    id: spec.id,
    category: spec.category,
    description: spec.description,
    defaultConfig: spec.defaultConfig as Record<string, unknown>,
    build: (config?: Record<string, unknown>) =>
      spec.build({ ...spec.defaultConfig, ...(config as Partial<C> | undefined) }),
  };
}

/** Materialise a {@link Rule} from a blueprint (optionally tuned config). */
export function buildRule(blueprint: RuleBlueprint, config?: Record<string, unknown>): Rule {
  return {
    id: blueprint.id,
    category: blueprint.category,
    description: blueprint.description,
    evaluate: blueprint.build(config),
  };
}

interface AgeTier {
  minDays: number;
  points: number;
}

/** Canonical order; hard gates short-circuit in this order. */
export const RULE_LIBRARY: RuleBlueprint[] = [
  // ───────────────────────── hard gates ─────────────────────────
  defineRule({
    id: 'gate.ghana_card_verified',
    category: 'hard_gate',
    description: 'Ghana Card must be verified',
    defaultConfig: {},
    build: () => (f) => ({
      passed: f.identity.ghanaCardVerified,
      points: 0,
      reason: f.identity.ghanaCardVerified ? undefined : 'Ghana Card not verified',
    }),
  }),
  defineRule({
    id: 'gate.phone_age',
    category: 'hard_gate',
    description: 'Phone number must be at least N days old',
    defaultConfig: { minDays: 30 },
    build:
      ({ minDays }) =>
      (f) => ({
        passed: f.identity.phoneAgeDays >= minDays,
        points: 0,
        reason: f.identity.phoneAgeDays < minDays ? 'Phone number too new' : undefined,
      }),
  }),
  defineRule({
    id: 'gate.no_recent_default',
    category: 'hard_gate',
    description: 'No defaults in the last 12 months',
    defaultConfig: { maxDefaults12mo: 0 },
    build:
      ({ maxDefaults12mo }) =>
      (f) => ({
        passed: f.repayment.priorDefaults12mo <= maxDefaults12mo,
        points: 0,
        reason:
          f.repayment.priorDefaults12mo > maxDefaults12mo ? 'Recent default on file' : undefined,
      }),
  }),
  defineRule({
    id: 'gate.amount_in_range',
    category: 'hard_gate',
    description: 'Order amount within plan template bounds',
    defaultConfig: {},
    build: () => (f) => {
      const ok =
        f.request.orderAmountGhs >= f.request.planMinGhs &&
        f.request.orderAmountGhs <= f.request.planMaxGhs;
      return { passed: ok, points: 0, reason: ok ? undefined : 'Amount outside plan limits' };
    },
  }),
  defineRule({
    id: 'gate.not_blocklisted',
    category: 'hard_gate',
    description: 'Customer not on internal blocklist',
    defaultConfig: {},
    build: () => (f) => ({
      passed: !f.exposure.isOnBlocklist,
      points: 0,
      reason: f.exposure.isOnBlocklist ? 'Customer blocked' : undefined,
    }),
  }),
  defineRule({
    id: 'gate.age_range',
    category: 'hard_gate',
    description: 'Age within the accepted range',
    defaultConfig: { minAge: 18, maxAge: 70 },
    build:
      ({ minAge, maxAge }) =>
      (f) => {
        const age = f.identity.ageYears;
        const ok = age !== null && age >= minAge && age <= maxAge;
        return { passed: ok, points: 0, reason: ok ? undefined : 'Age out of range or unknown' };
      },
  }),

  // ─────────────────────── weighted scoring ───────────────────────
  defineRule({
    id: 'score.on_time_rate',
    category: 'score',
    description: 'Award points for on-time payment rate',
    defaultConfig: { maxPoints: 250, rampPlans: 3 },
    build:
      ({ maxPoints, rampPlans }) =>
      (f) => {
        const plans = f.repayment.completedPlansCount;
        if (plans === 0) return { passed: true, points: 0 };
        const dampener = Math.min(plans / rampPlans, 1);
        return {
          passed: true,
          points: Math.round(maxPoints * f.repayment.onTimePaymentRate * dampener),
        };
      },
  }),
  defineRule({
    id: 'score.consecutive_on_time',
    category: 'score',
    description: 'Bonus for streak of on-time payments',
    defaultConfig: { pointsPerStreak: 10, cap: 100 },
    build:
      ({ pointsPerStreak, cap }) =>
      (f) => ({
        passed: true,
        points: Math.min(f.repayment.consecutiveOnTime * pointsPerStreak, cap),
      }),
  }),
  defineRule({
    id: 'score.no_prior_defaults',
    category: 'score',
    description: 'Clean record (lifetime) bonus',
    defaultConfig: { points: 50 },
    build:
      ({ points }) =>
      (f) => ({
        passed: true,
        points: f.repayment.priorDefaultsAllTime === 0 ? points : 0,
      }),
  }),
  defineRule({
    id: 'score.successful_charges',
    category: 'score',
    // NOT the customer's payment history at large. `BehaviorCollector` joins
    // `payment_attempts` to this customer's own plans, so what this counts is
    // instalment charges WE collected successfully. The old name,
    // `score.paystack_history` over a `paystackTransactionCount` field, read as
    // though a shopper with a busy Paystack life scored well here. They do not,
    // and anyone tuning the rule on that reading would have been tuning
    // something else entirely.
    description: 'Instalment charges we have collected from this customer',
    defaultConfig: { multiplier: 25, cap: 100 },
    build:
      ({ multiplier, cap }) =>
      (f) => ({
        passed: true,
        points: Math.min(
          Math.round(Math.log2(f.behavior.successfulChargeCount + 1) * multiplier),
          cap,
        ),
      }),
  }),
  defineRule({
    id: 'score.low_failure_rate',
    category: 'score',
    description: 'Penalise high failed-charge rate',
    defaultConfig: {
      highThreshold: 0.3,
      highPenalty: -50,
      lowThreshold: 0.05,
      lowPoints: 50,
      midPoints: 25,
    },
    build:
      ({ highThreshold, highPenalty, lowThreshold, lowPoints, midPoints }) =>
      (f) => {
        const rate = f.behavior.failedChargeRate90d;
        if (rate > highThreshold)
          return { passed: true, points: highPenalty, reason: 'High recent failure rate' };
        if (rate < lowThreshold) return { passed: true, points: lowPoints };
        return { passed: true, points: midPoints };
      },
  }),
  defineRule({
    id: 'score.payment_diversity',
    category: 'score',
    description: 'Multiple payment methods available',
    defaultConfig: { lowShare: 0.2, highShare: 0.8, balancedPoints: 50, unbalancedPoints: 25 },
    build:
      ({ lowShare, highShare, balancedPoints, unbalancedPoints }) =>
      (f) => {
        const share = f.behavior.momoTransactionShare;
        const balanced = share > lowShare && share < highShare;
        return { passed: true, points: balanced ? balancedPoints : unbalancedPoints };
      },
  }),
  defineRule({
    id: 'score.account_age',
    category: 'score',
    description: 'Account age in days',
    defaultConfig: {
      tiers: [
        { minDays: 365, points: 100 },
        { minDays: 180, points: 70 },
        { minDays: 90, points: 40 },
        { minDays: 30, points: 20 },
      ] as AgeTier[],
    },
    build:
      ({ tiers }) =>
      (f) => {
        const days = f.tenure.accountAgeDays;
        for (const tier of tiers)
          if (days >= tier.minDays) return { passed: true, points: tier.points };
        return { passed: true, points: 0 };
      },
  }),
  defineRule({
    id: 'score.device_stability',
    category: 'score',
    /**
     * Stable device fingerprint.
     *
     * Dead in production, and deliberately still here. `TenureCollector`
     * hardcodes `deviceFingerprintKnown: false` — no device telemetry is
     * captured — so the first line below short-circuits for every customer and
     * the 50 points cannot be earned by anyone.
     *
     * The fail-open guard is right: "we cannot see your devices" must not be
     * scored as "you have too many". What is wrong is that the scale claims
     * 1000 while production tops out at 900, and a reader sees a device
     * control that does nothing. `scoring-engine.ts` makes the case directly —
     * "a rule that can never fire is worse than no rule, because it reads as
     * protection" — and routed `phoneVerified` out for exactly this reason.
     * This one needs the signal captured rather than the rule rewritten, so it
     * stays priced and `reachable-ceiling.spec.ts` holds the gap at 50.
     */
    description: 'Stable device fingerprint',
    defaultConfig: { maxDevices: 3, points: 50 },
    build:
      ({ maxDevices, points }) =>
      (f) => {
        if (!f.tenure.deviceFingerprintKnown) return { passed: true, points: 0 };
        if (f.tenure.distinctDevicesLast90Days > maxDevices) {
          return { passed: true, points: 0, reason: 'Many devices in 90d' };
        }
        return { passed: true, points };
      },
  }),
  defineRule({
    id: 'score.employer_linked',
    category: 'score',
    // Was "Verified employer linkage", which it never checked — the collector
    // reports a link an operator typed. Verification gates the approval path in
    // the engine instead; here a live link is worth points on its own.
    description: 'Employer linkage (employer active)',
    defaultConfig: { base: 75, consentBonus: 50, tenureBonusMonths: 12, tenureBonus: 25 },
    build:
      ({ base, consentBonus, tenureBonusMonths, tenureBonus }) =>
      (f) => {
        if (!f.employment.employerLinked) return { passed: true, points: 0 };
        const consent = f.employment.payrollDeductionConsent ? consentBonus : 0;
        const tenure = (f.employment.employmentMonths ?? 0) >= tenureBonusMonths ? tenureBonus : 0;
        return { passed: true, points: base + consent + tenure };
      },
  }),
  defineRule({
    id: 'score.kyc_tier',
    category: 'score',
    /**
     * Higher KYC tier = more trust.
     *
     *   tier 1  a Ghana Card a person has checked against the details on file
     *   tier 2  a Ghana Card the National Identification Authority confirms
     *
     * Tier 2 is the NIA check because it is the one identity signal nothing
     * else here already counts — employment and repayment history are scored
     * by their own rules — and the one a forged scan cannot pass.
     *
     * Defined, and still unreachable in production: tier 2 is earned only by a
     * verifier that reports `authority: 'nia'`, and production binds
     * `ManualReviewGhanaCardVerifier` until the NIA client exists. Binding that
     * client is all that is left; `reachable-ceiling.spec.ts` pins the 50-point
     * gap until then.
     */
    description: 'Higher KYC tier = more trust',
    defaultConfig: { tier1: 50, tier2: 100 },
    build:
      ({ tier1, tier2 }) =>
      (f) => ({
        passed: true,
        points: f.identity.kycTier === 2 ? tier2 : f.identity.kycTier === 1 ? tier1 : 0,
      }),
  }),

  // ────────────────────── exposure / velocity ──────────────────────
  defineRule({
    id: 'exposure.max_concurrent',
    category: 'exposure',
    description: 'Maximum concurrent active plans',
    defaultConfig: { maxActive: 3 },
    build:
      ({ maxActive }) =>
      (f) => ({
        passed: f.exposure.activePlansCount < maxActive,
        points: 0,
        reason: f.exposure.activePlansCount >= maxActive ? 'Too many active plans' : undefined,
      }),
  }),
  defineRule({
    id: 'exposure.velocity',
    category: 'exposure',
    description: 'Velocity check — too many applications recently',
    defaultConfig: { maxPer24h: 5 },
    build:
      ({ maxPer24h }) =>
      (f) => ({
        passed: f.exposure.applicationsLast24h < maxPer24h,
        points: 0,
        reason: f.exposure.applicationsLast24h >= maxPer24h ? 'Velocity limit hit' : undefined,
      }),
  }),
];

/** Blueprints keyed by rule id (preserves the canonical library order). */
export const RULE_BLUEPRINTS: Record<string, RuleBlueprint> = Object.fromEntries(
  RULE_LIBRARY.map((b) => [b.id, b]),
);
