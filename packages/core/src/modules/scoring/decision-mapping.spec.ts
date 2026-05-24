import { describe, expect, it } from 'vitest';
import { declineReason, toCreditProfileValues, toRecordDecisionInput } from './decision-mapping';
import type { FeatureVector, RuleResult, ScoringDecision } from './types';

const FEATURES = { request: { orderAmountGhs: 5000 } } as unknown as FeatureVector;

function decision(overrides: Partial<ScoringDecision> = {}): ScoringDecision {
  return {
    outcome: 'approved',
    score: 720,
    riskBand: 'prime',
    approvedLimitGhs: 5000,
    rulesetVersion: 'v1.0.0',
    rulesFired: [],
    featuresSnapshot: FEATURES,
    decidedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('toRecordDecisionInput', () => {
  it('passes simple outcomes through with no extra fields', () => {
    expect(toRecordDecisionInput(decision({ outcome: 'approved' }))).toEqual({
      outcome: 'approved',
    });
    expect(toRecordDecisionInput(decision({ outcome: 'approved_tier_2' }))).toEqual({
      outcome: 'approved_tier_2',
    });
    expect(toRecordDecisionInput(decision({ outcome: 'manual_review' }))).toEqual({
      outcome: 'manual_review',
    });
  });

  it('attaches the first failing rule reason to a decline', () => {
    const rulesFired: RuleResult[] = [
      {
        ruleId: 'gate.ghana_card_verified',
        category: 'hard_gate',
        passed: false,
        points: 0,
        reason: 'Ghana Card not verified',
      },
    ];
    expect(toRecordDecisionInput(decision({ outcome: 'declined', score: 0, rulesFired }))).toEqual({
      outcome: 'declined',
      declined_reason: 'Ghana Card not verified',
    });
  });

  it('falls back to a score message when a decline has no failing-rule reason', () => {
    expect(declineReason(decision({ outcome: 'declined', score: 120, rulesFired: [] }))).toBe(
      'Score 120 below approval threshold',
    );
  });

  it('converts a counter-offer to integer pesewas', () => {
    const d = decision({
      outcome: 'counter_offer',
      counterOffer: { downPaymentGhs: 1500, revisedAmountGhs: 3500, revisedTermMonths: 3 },
    });
    expect(toRecordDecisionInput(d)).toEqual({
      outcome: 'counter_offer',
      counter_down_payment_pesewas: 150_000,
      counter_financed_pesewas: 350_000,
    });
  });

  it('throws if a counter_offer decision lacks its counterOffer', () => {
    expect(() => toRecordDecisionInput(decision({ outcome: 'counter_offer' }))).toThrow();
  });
});

describe('toCreditProfileValues', () => {
  it('maps every field and converts the limit to pesewas', () => {
    const rulesFired: RuleResult[] = [
      { ruleId: 'score.kyc_tier', category: 'score', passed: true, points: 100 },
    ];
    const row = toCreditProfileValues(
      'cust-1',
      'app-1',
      decision({ approvedLimitGhs: 4200, rulesFired }),
    );
    expect(row).toEqual({
      customer_id: 'cust-1',
      application_id: 'app-1',
      score: 720,
      risk_band: 'prime',
      outcome: 'approved',
      approved_limit_pesewas: 420_000,
      ruleset_version: 'v1.0.0',
      rules_fired: rulesFired,
      features_snapshot: FEATURES,
      decided_at: '2026-01-01T00:00:00.000Z',
    });
  });

  it('rounds a fractional cedi limit to whole pesewas', () => {
    const row = toCreditProfileValues('c', 'a', decision({ approvedLimitGhs: 3499.5 }));
    expect(row.approved_limit_pesewas).toBe(349_950);
  });
});
