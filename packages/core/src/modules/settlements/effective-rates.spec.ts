import { describe, expect, it } from 'vitest';
import { MODEL_CONFIG, effectiveRates, type BusinessModel } from './model-config';

/**
 * "The merchant's deal, else the business model's own rate" — in one place.
 *
 * Activation freezes this onto every plan, and the seller's app is shown it.
 * When those were two expressions of the same rule, the app printed the
 * model-agnostic `default_mdr_bps` (a flat 4%) while layaway charged 3% and
 * rent-to-own 5%.
 */
describe('effectiveRates', () => {
  const MODELS = Object.keys(MODEL_CONFIG) as BusinessModel[];
  const NONE = { mdrBpsOverride: null, reserveBpsOverride: null };

  it("charges each business model's own rate when nothing was negotiated", () => {
    for (const model of MODELS) {
      expect(effectiveRates(model, NONE)).toEqual({
        mdrBps: MODEL_CONFIG[model].mdrBps,
        reserveBps: MODEL_CONFIG[model].reserveBps,
      });
    }
    // Pinned as numbers too, so a change to MODEL_CONFIG is a visible decision.
    expect(MODELS.map((m) => effectiveRates(m, NONE))).toEqual([
      { mdrBps: 400, reserveBps: 500 },
      { mdrBps: 300, reserveBps: 200 },
      { mdrBps: 400, reserveBps: 700 },
      { mdrBps: 500, reserveBps: 1200 },
    ]);
  });

  it('applies a negotiated MDR to every model, and leaves the reserve to the model', () => {
    for (const model of MODELS) {
      expect(effectiveRates(model, { mdrBpsOverride: 250, reserveBpsOverride: null })).toEqual({
        mdrBps: 250,
        reserveBps: MODEL_CONFIG[model].reserveBps,
      });
    }
  });

  it('treats a negotiated 0 as a rate rather than as nothing', () => {
    expect(effectiveRates('rent_to_own', { mdrBpsOverride: 0, reserveBpsOverride: 0 })).toEqual({
      mdrBps: 0,
      reserveBps: 0,
    });
  });
});
