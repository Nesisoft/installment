import { describe, expect, it } from 'vitest';
import { ScoringEngine } from './scoring-engine';
import { SCORING_RULES } from './ruleset';
import type { FeatureVector } from './types';

/**
 * What the rule library can award, against what the collectors can actually
 * produce.
 *
 * `scoring-engine.ts` states the principle this file enforces: "A rule that can
 * never fire is worse than no rule, because it reads as protection." It says so
 * while deliberately routing around `identity.phoneVerified`, a field the
 * collector returns as a constant `false`.
 *
 * Two scoring tiers are in exactly that position and were not routed around:
 *
 *   score.device_stability (50)  reads `tenure.deviceFingerprintKnown`, which
 *                                TenureCollector hardcodes to `false` — device
 *                                telemetry is not captured. The rule's first
 *                                line short-circuits to 0 points for everyone.
 *   score.kyc_tier tier 2 (+50)  no code path anywhere writes `kyc_tier = 2`.
 *                                Tier 1 pays 50 and tier 2 pays 100, so the
 *                                unreachable part is the 50-point uplift.
 *                                Approving a Ghana card caps at 1
 *                                (`previousTier < 1 ? 1 : previousTier`),
 *                                rejection demotes, and the only other mention
 *                                is a list *filter*. The value exists in the DB
 *                                CHECK and in this rule, and nowhere else.
 *
 * So the scale reads 0..1000 and tops out at 900 in production. These tests
 * pin both numbers. If a collector starts producing one of those signals, or a
 * promotion path to tier 2 is built, the reachable figure moves and this fails
 * — which is the point: the gap should never widen quietly again.
 */
describe('scoring reachable ceiling', () => {
  const engine = new ScoringEngine();

  /** Every gate passed, every scoring rule at its maximum. */
  function perfect(): FeatureVector {
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
        completedPlansCount: 10,
        onTimePaymentRate: 1,
        averageDaysPastDue: 0,
        priorDefaults12mo: 0,
        priorDefaultsAllTime: 0,
        consecutiveOnTime: 20,
      },
      behavior: {
        successfulChargeCount: 20,
        momoTransactionShare: 0.5,
        averageTransactionGhs: 500,
        failedChargeRate90d: 0,
      },
      tenure: {
        accountAgeDays: 900,
        loginsLast30Days: 30,
        deviceFingerprintKnown: true,
        distinctDevicesLast90Days: 1,
      },
      employment: {
        employerLinked: true,
        employerVerified: true,
        salaryBand: 'high',
        employmentMonths: 60,
        payrollDeductionConsent: true,
      },
      exposure: {
        activePlansCount: 0,
        outstandingBalanceGhs: 0,
        currentLimitGhs: 0,
        applicationsLast24h: 1,
        isOnBlocklist: false,
      },
      request: {
        orderAmountGhs: 500,
        merchantCategory: 'electronics',
        planTemplateId: 'tpl',
        planMinGhs: 10,
        planMaxGhs: 10_000,
        downPaymentBps: 0,
      },
    };
  }

  /**
   * The best vector the collectors can actually emit: device telemetry is not
   * captured, and nothing promotes a customer past tier 1.
   */
  function bestCollectable(): FeatureVector {
    const f = perfect();
    f.identity.phoneVerified = false; // IdentityCollector: hardcoded
    f.identity.addressProofUploaded = false; // IdentityCollector: hardcoded
    f.identity.kycTier = 1; // nothing writes 2
    f.tenure.loginsLast30Days = 0; // TenureCollector: hardcoded
    f.tenure.deviceFingerprintKnown = false; // TenureCollector: hardcoded
    f.tenure.distinctDevicesLast90Days = 0; // TenureCollector: hardcoded
    return f;
  }

  it('the rule library is designed to total exactly 1000', () => {
    const decision = engine.score(perfect());
    expect(decision.score).toBe(1000);
    expect(decision.riskBand).toBe('prime');
  });

  it('but production can only ever reach 900', () => {
    const decision = engine.score(bestCollectable());
    expect(decision.score).toBe(900);
  });

  it('names exactly which rules production can never earn', () => {
    const ideal = engine.score(perfect()).rulesFired;
    const real = engine.score(bestCollectable()).rulesFired;

    const lost = ideal
      .filter((r) => r.category === 'score')
      .filter((r) => {
        const same = real.find((x) => x.ruleId === r.ruleId);
        return same !== undefined && same.points < r.points;
      })
      .map((r) => ({
        ruleId: r.ruleId,
        unreachablePoints: r.points - real.find((x) => x.ruleId === r.ruleId)!.points,
      }));

    expect(lost).toEqual([
      { ruleId: 'score.device_stability', unreachablePoints: 50 },
      { ruleId: 'score.kyc_tier', unreachablePoints: 50 },
    ]);
  });

  it('prime is still reachable despite the gap, so approvals are not blocked', () => {
    // 850 clears the 700 prime floor. Worth pinning: if a future rule change
    // pushed the reachable ceiling under 700, `approved` and the GHS 5000
    // limit would become unreachable and every approval would silently drop to
    // approved_tier_2 — with nothing failing.
    const decision = engine.score(bestCollectable());
    expect(decision.score).toBeGreaterThanOrEqual(700);
    expect(decision.riskBand).toBe('prime');
    expect(decision.outcome).toBe('approved');
  });

  it('every scoring rule in the default ruleset is reachable, or named here', () => {
    // A rule awarding zero to a perfect customer is unearnable by anyone.
    const ideal = engine.score(perfect()).rulesFired;
    const deadEvenWhenPerfect = ideal
      .filter((r) => r.category === 'score' && r.points === 0)
      .map((r) => r.ruleId);
    expect(deadEvenWhenPerfect).toEqual([]);
    expect(SCORING_RULES.length).toBeGreaterThan(0);
  });
});
