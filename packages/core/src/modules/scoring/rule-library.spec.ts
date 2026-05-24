import { describe, expect, it } from 'vitest';
import { RULE_BLUEPRINTS, RULE_LIBRARY, buildRule } from './rule-library';
import type { FeatureVector } from './types';

const f = (slice: Partial<FeatureVector>): FeatureVector => slice as unknown as FeatureVector;

describe('RULE_LIBRARY', () => {
  it('registers every rule with a unique id', () => {
    expect(RULE_LIBRARY).toHaveLength(18);
    expect(Object.keys(RULE_BLUEPRINTS)).toHaveLength(18);
    expect(RULE_BLUEPRINTS['gate.phone_age']).toBeDefined();
    expect(RULE_BLUEPRINTS['score.kyc_tier']).toBeDefined();
    expect(RULE_BLUEPRINTS['exposure.velocity']).toBeDefined();
  });

  it('buildRule carries the blueprint metadata', () => {
    const rule = buildRule(RULE_BLUEPRINTS['gate.phone_age']!);
    expect(rule.id).toBe('gate.phone_age');
    expect(rule.category).toBe('hard_gate');
  });
});

describe('configuration tuning', () => {
  it('gate.phone_age threshold is configurable', () => {
    const input = f({ identity: { phoneAgeDays: 10 } as FeatureVector['identity'] });
    expect(RULE_BLUEPRINTS['gate.phone_age']!.build()(input).passed).toBe(false);
    expect(RULE_BLUEPRINTS['gate.phone_age']!.build({ minDays: 5 })(input).passed).toBe(true);
  });

  it('score.kyc_tier weights are configurable', () => {
    const input = f({ identity: { kycTier: 2 } as FeatureVector['identity'] });
    expect(RULE_BLUEPRINTS['score.kyc_tier']!.build()(input).points).toBe(100);
    expect(RULE_BLUEPRINTS['score.kyc_tier']!.build({ tier2: 500 })(input).points).toBe(500);
  });

  it('score.on_time_rate max points are configurable', () => {
    const input = f({
      repayment: { completedPlansCount: 3, onTimePaymentRate: 1 } as FeatureVector['repayment'],
    });
    expect(RULE_BLUEPRINTS['score.on_time_rate']!.build()(input).points).toBe(250);
    expect(RULE_BLUEPRINTS['score.on_time_rate']!.build({ maxPoints: 100 })(input).points).toBe(
      100,
    );
  });

  it('score.account_age tiers are configurable', () => {
    const input = f({ tenure: { accountAgeDays: 200 } as FeatureVector['tenure'] });
    expect(RULE_BLUEPRINTS['score.account_age']!.build()(input).points).toBe(70);
    const tuned = RULE_BLUEPRINTS['score.account_age']!.build({
      tiers: [{ minDays: 100, points: 999 }],
    });
    expect(tuned(input).points).toBe(999);
  });

  it('a partial config falls back to defaults for unspecified keys', () => {
    // Only override consentBonus; base + tenureBonus keep their defaults.
    const ev = RULE_BLUEPRINTS['score.employer_linked']!.build({ consentBonus: 200 });
    const input = f({
      employment: {
        employerLinked: true,
        payrollDeductionConsent: true,
        employmentMonths: 24,
        salaryBand: 'mid',
      },
    });
    expect(ev(input).points).toBe(75 + 200 + 25);
  });
});
