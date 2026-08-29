import { describe, expect, it } from 'vitest';
import { ScoringEngine } from './scoring-engine';
import { RULESET_VERSION } from './ruleset';
import type { FeatureVector, RuleResult, ScoringDecision } from './types';

const engine = new ScoringEngine();
const NOW = new Date('2026-05-22T00:00:00.000Z');

/** A maxed-out prime applicant; tests override slices of it. */
function prime(): FeatureVector {
  return {
    identity: {
      ghanaCardVerified: true,
      phoneVerified: true,
      phoneAgeDays: 400,
      addressProofUploaded: true,
      kycTier: 2,
      ageYears: 35,
    },
    repayment: {
      completedPlansCount: 5,
      onTimePaymentRate: 1,
      averageDaysPastDue: 0,
      priorDefaults12mo: 0,
      priorDefaultsAllTime: 0,
      consecutiveOnTime: 12,
    },
    behavior: {
      paystackTransactionCount: 100,
      momoTransactionShare: 0.5,
      averageTransactionGhs: 200,
      failedChargeRate90d: 0,
    },
    tenure: {
      accountAgeDays: 400,
      loginsLast30Days: 10,
      deviceFingerprintKnown: true,
      distinctDevicesLast90Days: 1,
    },
    employment: {
      employerLinked: true,
      salaryBand: 'high',
      employmentMonths: 24,
      payrollDeductionConsent: true,
    },
    exposure: {
      activePlansCount: 0,
      outstandingBalanceGhs: 0,
      currentLimitGhs: 0,
      applicationsLast24h: 0,
      isOnBlocklist: false,
    },
    request: {
      orderAmountGhs: 1000,
      merchantCategory: 'electronics',
      planTemplateId: 'p1',
      planMinGhs: 100,
      planMaxGhs: 5000,
      downPaymentBps: 4000,
    },
  };
}

type Sections = keyof FeatureVector;
function make(overrides: Partial<{ [K in Sections]: Partial<FeatureVector[K]> }>): FeatureVector {
  const base = prime();
  const out = { ...base } as FeatureVector;
  for (const key of Object.keys(overrides) as Sections[]) {
    out[key] = { ...base[key], ...overrides[key] } as never;
  }
  return out;
}

const pointsOf = (d: ScoringDecision, ruleId: string): number | undefined =>
  d.rulesFired.find((r) => r.ruleId === ruleId)?.points;
const fired = (d: ScoringDecision, ruleId: string): RuleResult | undefined =>
  d.rulesFired.find((r) => r.ruleId === ruleId);

describe('ScoringEngine — baseline & reproducibility', () => {
  it('approves a maxed-out prime applicant with score capped at 1000', () => {
    const d = engine.score(prime(), NOW);
    expect(d.outcome).toBe('approved');
    expect(d.score).toBe(1000);
    expect(d.riskBand).toBe('prime');
    expect(d.approvedLimitGhs).toBe(10_000); // 5000 base × 2 payroll multiplier
    expect(d.counterOffer).toBeUndefined();
    expect(d.rulesetVersion).toBe(RULESET_VERSION);
    expect(d.rulesFired).toHaveLength(6 + 10 + 2); // gates + score + exposure
    expect(d.decidedAt).toBe(NOW);
  });

  it('is reproducible: same features + same ruleset → identical score/outcome/rulesFired', () => {
    const f = make({ repayment: { completedPlansCount: 3, onTimePaymentRate: 0.9 } });
    const a = engine.score(f, NOW);
    const b = engine.score(f, NOW);
    expect(b.score).toBe(a.score);
    expect(b.outcome).toBe(a.outcome);
    expect(b.rulesFired).toEqual(a.rulesFired);
  });
});

describe('ScoringEngine — hard gates short-circuit to declined', () => {
  const cases: Array<[string, FeatureVector, string]> = [
    [
      'ghana card not verified',
      make({ identity: { ghanaCardVerified: false } }),
      'gate.ghana_card_verified',
    ],
    ['phone too new', make({ identity: { phoneAgeDays: 10 } }), 'gate.phone_age'],
    ['recent default', make({ repayment: { priorDefaults12mo: 1 } }), 'gate.no_recent_default'],
    ['amount above plan max', make({ request: { orderAmountGhs: 6000 } }), 'gate.amount_in_range'],
    ['blocklisted', make({ exposure: { isOnBlocklist: true } }), 'gate.not_blocklisted'],
    ['age null', make({ identity: { ageYears: null } }), 'gate.age_range'],
    ['age below 18', make({ identity: { ageYears: 17 } }), 'gate.age_range'],
    ['age above 70', make({ identity: { ageYears: 71 } }), 'gate.age_range'],
  ];

  it.each(cases)('declines when %s', (_label, features, gateId) => {
    const d = engine.score(features, NOW);
    expect(d.outcome).toBe('declined');
    expect(d.score).toBe(0);
    expect(d.riskBand).toBe('unscorable');
    const gate = fired(d, gateId);
    expect(gate?.passed).toBe(false);
    expect(gate?.reason).toBeTruthy();
    // First failing gate short-circuits — no scoring rules evaluated.
    expect(d.rulesFired.some((r) => r.category === 'score')).toBe(false);
  });
});

describe('ScoringEngine — exposure gates decline after scoring', () => {
  it('declines on too many concurrent active plans', () => {
    const d = engine.score(make({ exposure: { activePlansCount: 3 } }), NOW);
    expect(d.outcome).toBe('declined');
    expect(fired(d, 'exposure.max_concurrent')?.passed).toBe(false);
    expect(d.rulesFired.some((r) => r.category === 'score')).toBe(true); // scoring ran first
  });

  it('declines on application velocity', () => {
    const d = engine.score(make({ exposure: { applicationsLast24h: 5 } }), NOW);
    expect(d.outcome).toBe('declined');
    expect(fired(d, 'exposure.velocity')?.passed).toBe(false);
  });
});

describe('ScoringEngine — scoring rule math', () => {
  it('on_time_rate ramps over the first 3 plans', () => {
    expect(
      pointsOf(
        engine.score(make({ repayment: { completedPlansCount: 0 } }), NOW),
        'score.on_time_rate',
      ),
    ).toBe(0);
    expect(
      pointsOf(
        engine.score(make({ repayment: { completedPlansCount: 1, onTimePaymentRate: 1 } }), NOW),
        'score.on_time_rate',
      ),
    ).toBe(83); // round(250 * 1 * 1/3)
    expect(
      pointsOf(
        engine.score(make({ repayment: { completedPlansCount: 3, onTimePaymentRate: 1 } }), NOW),
        'score.on_time_rate',
      ),
    ).toBe(250);
  });

  it('consecutive_on_time is capped at 100', () => {
    expect(
      pointsOf(
        engine.score(make({ repayment: { consecutiveOnTime: 4 } }), NOW),
        'score.consecutive_on_time',
      ),
    ).toBe(40);
    expect(
      pointsOf(
        engine.score(make({ repayment: { consecutiveOnTime: 50 } }), NOW),
        'score.consecutive_on_time',
      ),
    ).toBe(100);
  });

  it('paystack_history uses a capped log2 scale', () => {
    expect(
      pointsOf(
        engine.score(make({ behavior: { paystackTransactionCount: 0 } }), NOW),
        'score.paystack_history',
      ),
    ).toBe(0);
    expect(
      pointsOf(
        engine.score(make({ behavior: { paystackTransactionCount: 3 } }), NOW),
        'score.paystack_history',
      ),
    ).toBe(50);
    expect(
      pointsOf(
        engine.score(make({ behavior: { paystackTransactionCount: 100000 } }), NOW),
        'score.paystack_history',
      ),
    ).toBe(100);
  });

  it('low_failure_rate banding (penalty / neutral / bonus)', () => {
    expect(
      pointsOf(
        engine.score(make({ behavior: { failedChargeRate90d: 0.4 } }), NOW),
        'score.low_failure_rate',
      ),
    ).toBe(-50);
    expect(
      pointsOf(
        engine.score(make({ behavior: { failedChargeRate90d: 0.1 } }), NOW),
        'score.low_failure_rate',
      ),
    ).toBe(25);
    expect(
      pointsOf(
        engine.score(make({ behavior: { failedChargeRate90d: 0.01 } }), NOW),
        'score.low_failure_rate',
      ),
    ).toBe(50);
  });

  it('account_age tiers', () => {
    const at = (days: number) =>
      pointsOf(engine.score(make({ tenure: { accountAgeDays: days } }), NOW), 'score.account_age');
    expect(at(10)).toBe(0);
    expect(at(30)).toBe(20);
    expect(at(90)).toBe(40);
    expect(at(180)).toBe(70);
    expect(at(365)).toBe(100);
  });

  it('kyc_tier and employer_linked composition', () => {
    expect(pointsOf(engine.score(make({ identity: { kycTier: 0 } }), NOW), 'score.kyc_tier')).toBe(
      0,
    );
    expect(pointsOf(engine.score(make({ identity: { kycTier: 1 } }), NOW), 'score.kyc_tier')).toBe(
      50,
    );
    expect(
      pointsOf(
        engine.score(
          make({
            employment: {
              employerLinked: true,
              payrollDeductionConsent: false,
              employmentMonths: 3,
            },
          }),
          NOW,
        ),
        'score.employer_linked',
      ),
    ).toBe(75); // base only
    expect(
      pointsOf(
        engine.score(make({ employment: { employerLinked: false } }), NOW),
        'score.employer_linked',
      ),
    ).toBe(0);
  });
});

describe('ScoringEngine — bands, limits, outcomes', () => {
  it('near_prime + fitting order → approved_tier_2', () => {
    // Drop to near_prime: no payroll consent, modest history.
    const f = make({
      identity: { kycTier: 1 },
      repayment: { completedPlansCount: 3, onTimePaymentRate: 0.8, consecutiveOnTime: 2 },
      employment: { employerLinked: false, payrollDeductionConsent: false },
      behavior: { paystackTransactionCount: 16, failedChargeRate90d: 0.1 },
      tenure: { accountAgeDays: 200, distinctDevicesLast90Days: 1 },
      request: { orderAmountGhs: 500 },
    });
    const d = engine.score(f, NOW);
    expect(d.riskBand).toBe('near_prime');
    expect(d.outcome).toBe('approved_tier_2');
  });

  it('payroll consent doubles the limit; outstanding balance reduces headroom', () => {
    const withConsent = engine.score(prime(), NOW);
    expect(withConsent.approvedLimitGhs).toBe(10_000);
    const noConsent = engine.score(make({ employment: { payrollDeductionConsent: false } }), NOW);
    // prime base 5000 × 1, employer_linked drops 50 but still prime.
    expect(noConsent.approvedLimitGhs).toBe(5000);
    const withBalance = engine.score(
      make({
        employment: { payrollDeductionConsent: false },
        exposure: { outstandingBalanceGhs: 1500 },
      }),
      NOW,
    );
    expect(withBalance.approvedLimitGhs).toBe(3500);
  });

  it('order exceeding the limit but ≥50% of it → counter_offer', () => {
    const f = make({
      // near_prime (~615), limit 2500 (no payroll multiplier)
      employment: { employerLinked: false, payrollDeductionConsent: false },
      identity: { kycTier: 1 },
      repayment: { completedPlansCount: 3, onTimePaymentRate: 0.8, consecutiveOnTime: 2 },
      behavior: { paystackTransactionCount: 16, failedChargeRate90d: 0.1 },
      tenure: { accountAgeDays: 200 },
      request: { orderAmountGhs: 4000, planMaxGhs: 5000 },
    });
    const d = engine.score(f, NOW);
    expect(d.outcome).toBe('counter_offer');
    expect(d.counterOffer).toEqual({
      downPaymentGhs: 1500,
      revisedAmountGhs: 2500,
      revisedTermMonths: 3,
    });
  });

  it('first-time customer with a high-value order → manual_review', () => {
    const f = make({
      repayment: {
        completedPlansCount: 0,
        onTimePaymentRate: 0,
        consecutiveOnTime: 0,
        priorDefaultsAllTime: 0,
      },
      employment: { payrollDeductionConsent: false }, // limit 2500 base near_prime
      identity: { kycTier: 1 },
      behavior: { paystackTransactionCount: 16, failedChargeRate90d: 0.1 },
      tenure: { accountAgeDays: 200 },
      exposure: { outstandingBalanceGhs: 1800 }, // limit → 700
      request: { orderAmountGhs: 2500, planMaxGhs: 5000 },
    });
    const d = engine.score(f, NOW);
    // limit 700 < order 2500 and 700 < 1250 (50%) → not counter; first-time + ≥2000 → review.
    expect(d.outcome).toBe('manual_review');
  });

  it('unscorable (very thin file) → declined', () => {
    const f = make({
      identity: { kycTier: 0 },
      repayment: {
        completedPlansCount: 0,
        onTimePaymentRate: 0,
        consecutiveOnTime: 0,
        priorDefaultsAllTime: 1,
      },
      behavior: { paystackTransactionCount: 0, momoTransactionShare: 0, failedChargeRate90d: 0.1 },
      tenure: { accountAgeDays: 0, deviceFingerprintKnown: false },
      employment: { employerLinked: false, payrollDeductionConsent: false },
      request: { orderAmountGhs: 100 },
    });
    const d = engine.score(f, NOW);
    expect(d.riskBand).toBe('unscorable');
    expect(d.outcome).toBe('declined');
  });
});

describe('ScoringEngine — custom ruleset seam', () => {
  it('uses the injected ruleset version and rules', () => {
    const custom = new ScoringEngine({
      version: 'test-v9',
      hardGates: [
        {
          id: 'gate.always_fail',
          category: 'hard_gate',
          description: 'always fails',
          evaluate: () => ({ passed: false, points: 0, reason: 'nope' }),
        },
      ],
      scoringRules: [],
      exposureRules: [],
    });
    const d = custom.score(prime(), NOW);
    expect(d.rulesetVersion).toBe('test-v9');
    expect(d.outcome).toBe('declined');
    expect(d.rulesFired).toHaveLength(1);
  });
});
