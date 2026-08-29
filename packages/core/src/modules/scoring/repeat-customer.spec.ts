import { describe, expect, it } from 'vitest';
import { ScoringEngine } from './scoring-engine';
import type { DecisionOutcome, FeatureVector } from './types';

const NOW = new Date('2026-08-29T00:00:00.000Z');
const engine = new ScoringEngine();

/**
 * The customer ladder — the thing the whole score is actually measuring.
 *
 * Nothing here reads a credit bureau. The score is "how well have they repaid
 * US", built from plans finished and instalments paid on time, so a customer
 * earns their way up by buying and paying, and these specs are that journey.
 *
 * They exist because it had a hole in it. The starter limit approves order one;
 * a customer with one completed plan then sat at ~458 — subprime — and order two
 * went to manual review until the third purchase pushed them past 500. Approved,
 * reviewed, approved: the extra friction landing on precisely the satisfied
 * first-time buyer who came back.
 */

/** A retail shopper who pays every instalment on time, plan after plan. */
function afterPlans(plans: number, accountAgeDays: number): FeatureVector {
  // "Pay in 4" is a deposit plus three instalments, so three charges per plan.
  const charges = plans * 3;
  return {
    identity: {
      ghanaCardVerified: true,
      phoneVerified: false,
      phoneAgeDays: 400,
      addressProofUploaded: false,
      kycTier: 2,
      ageYears: 30,
    },
    repayment: {
      completedPlansCount: plans,
      onTimePaymentRate: plans ? 1 : 0,
      averageDaysPastDue: 0,
      priorDefaults12mo: 0,
      priorDefaultsAllTime: 0,
      consecutiveOnTime: charges,
    },
    behavior: {
      successfulChargeCount: charges,
      momoTransactionShare: 1,
      averageTransactionGhs: 64,
      failedChargeRate90d: 0,
    },
    tenure: {
      accountAgeDays,
      loginsLast30Days: 4,
      deviceFingerprintKnown: true,
      distinctDevicesLast90Days: 1,
    },
    employment: {
      employerLinked: false,
      salaryBand: 'mid',
      employmentMonths: 0,
      payrollDeductionConsent: false,
    },
    exposure: {
      activePlansCount: 0,
      outstandingBalanceGhs: 0,
      currentLimitGhs: 0,
      applicationsLast24h: 0,
      isOnBlocklist: false,
    },
    request: {
      orderAmountGhs: 300,
      merchantCategory: 'electronics',
      planTemplateId: 'p1',
      planMinGhs: 50,
      planMaxGhs: 50_000,
      downPaymentBps: 4000,
    },
  };
}

const APPROVALS: DecisionOutcome[] = ['approved', 'approved_tier_2'];

describe('the repeat-customer ladder', () => {
  it('never sends a paying customer backwards', () => {
    // The property that matters more than any single row: buying again and
    // paying on time must not make the next purchase harder than the last.
    const journey = [
      afterPlans(0, 40),
      afterPlans(1, 70),
      afterPlans(2, 110),
      afterPlans(3, 150),
      afterPlans(6, 380),
    ].map((f) => engine.score(f, NOW));

    expect(journey.map((d) => APPROVALS.includes(d.outcome))).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
  });

  it('approves the second purchase without a human, after one clean plan', () => {
    const d = engine.score(afterPlans(1, 70), NOW);

    // Still subprime — one plan is not a lot of evidence, and the band says so.
    // But the band's own limit is already our appetite for a subprime customer,
    // so an order inside it does not need agreeing twice.
    expect(d.riskBand).toBe('subprime');
    expect(d.outcome).toBe('approved_tier_2');
  });

  it('grows the limit as the record grows', () => {
    const limits = [1, 2, 3].map((n) => engine.score(afterPlans(n, 70 + n * 40), NOW));

    expect(limits.map((d) => d.approvedLimitGhs)).toEqual([1_000, 2_500, 5_000]);
  });

  describe('what a record does not buy', () => {
    it('still refuses an order beyond the band limit', () => {
      const f = afterPlans(1, 70);
      f.request.orderAmountGhs = 5_000; // limit at subprime is 1,000
      const d = engine.score(f, NOW);

      expect(APPROVALS).not.toContain(d.outcome);
    });

    /**
     * A default is the strongest thing we know about somebody, and it does not
     * expire because they later completed something. `gate.no_recent_default`
     * only asks about the last twelve months; the approval branch added here
     * asks about ever, so an old default sends a subprime customer to a human.
     */
    it('sends a subprime customer with any past default to review', () => {
      const clean = afterPlans(1, 70);
      const marked = { ...clean, repayment: { ...clean.repayment, priorDefaultsAllTime: 1 } };

      expect(engine.score(clean, NOW).outcome).toBe('approved_tier_2');
      expect(engine.score(marked, NOW).riskBand).toBe('subprime');
      expect(engine.score(marked, NOW).outcome).toBe('manual_review');
    });

    /**
     * Above subprime it is the band that decides, and the band has always
     * forgiven an old default: `score.no_prior_defaults` withholds 50 points
     * rather than barring approval, so a customer who defaulted more than
     * twelve months ago and has since repaid two plans is approved on score
     * alone. That is the pre-existing policy, pinned here so it is a choice
     * somebody can see and revisit rather than a surprise found in production.
     */
    it('lets the band forgive an old default once the score is high enough', () => {
      const clean = afterPlans(2, 110);
      const marked = { ...clean, repayment: { ...clean.repayment, priorDefaultsAllTime: 1 } };
      const decision = engine.score(marked, NOW);

      expect(decision.riskBand).toBe('near_prime');
      expect(decision.outcome).toBe('approved_tier_2');
      // Visible in the score: the default costs exactly the 50 points the rule
      // withholds, and nothing more.
      expect(engine.score(clean, NOW).score - decision.score).toBe(50);
    });

    it('still declines someone who completed a plan but paid everything late', () => {
      // Not re-checked in the approval branch on purpose: the band already
      // prices it, through on_time_rate and consecutive_on_time. This proves
      // the band really does the work, rather than the branch trusting it does.
      const f = afterPlans(1, 70);
      f.repayment.onTimePaymentRate = 0;
      f.repayment.consecutiveOnTime = 0;
      const d = engine.score(f, NOW);

      expect(APPROVALS).not.toContain(d.outcome);
    });

    it('still refuses a blocklisted customer however good their record', () => {
      const f = afterPlans(6, 380);
      f.exposure.isOnBlocklist = true;

      expect(engine.score(f, NOW).outcome).toBe('declined');
    });
  });
});
