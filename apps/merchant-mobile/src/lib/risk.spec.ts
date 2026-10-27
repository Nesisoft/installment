import { describe, expect, it } from 'vitest';
import type { BusinessModel } from '@installment/api-types';
import { DEFAULT_RISK_SUMMARY, defaultRiskSentence, sharesDefaultLoss } from './risk';

/**
 * The app's account of a default, checked against `DefaultService`.
 *
 * Every model draws the plan's reserve first; past it, BNPL and rent to own
 * bill Ejua's default pool and hybrid bills the merchant's payable
 * (`default.integration.spec.ts`: a rent to own default leaves the payable at
 * 83,000 and books the 88,000 past the reserve to the pool). The app once said
 * Ejua carried the risk on every plan, and later that rent to own sellers
 * shared it — each true only of what the engine did at the time.
 */
describe('defaultRiskSentence', () => {
  it('says the seller shares the loss exactly where the engine bills them', () => {
    const models: BusinessModel[] = ['bnpl', 'layaway', 'hybrid', 'rent_to_own'];
    expect(models.filter(sharesDefaultLoss)).toEqual(['hybrid']);
    expect(defaultRiskSentence('hybrid')).toMatch(/comes off your future payouts/);
  });

  it('never tells a hybrid seller that Ejua carries the loss', () => {
    expect(defaultRiskSentence('hybrid')).not.toMatch(/Ejua carries/);
  });

  it('keeps what BNPL and rent to own credited the seller theirs, past the reserve', () => {
    for (const model of ['bnpl', 'rent_to_own'] as const) {
      expect(defaultRiskSentence(model)).toMatch(/reserve covers the loss first/);
      expect(defaultRiskSentence(model)).toMatch(/stays yours/);
      expect(defaultRiskSentence(model)).not.toMatch(/future payouts/);
    }
  });

  it('names the plan type the seller is sharing the risk on', () => {
    expect(defaultRiskSentence('hybrid')).toMatch(/Hybrid plans share/);
  });

  it('separates a late payment, which moves nothing, from a write-off', () => {
    for (const model of ['bnpl', 'hybrid', 'rent_to_own'] as const) {
      expect(defaultRiskSentence(model)).toMatch(/late payment takes nothing back/);
    }
    expect(DEFAULT_RISK_SUMMARY).toMatch(/On BNPL and rent to own Ejua carries the rest/);
    expect(DEFAULT_RISK_SUMMARY).toMatch(/on hybrid plans, the rest comes off/);
  });
});
