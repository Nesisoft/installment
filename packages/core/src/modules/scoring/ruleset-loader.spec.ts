import { describe, expect, it } from 'vitest';
import type { Database } from '@installment/db';
import { RulesetLoader } from './ruleset-loader';
import { DEFAULT_RULESET } from './ruleset';
import type { FeatureVector } from './types';

interface Row {
  rule_id: string;
  description: string;
  configuration: unknown;
}

function fakeDb(rows: Row[]): { db: Database; calls: () => number } {
  let calls = 0;
  const db = {
    select: () => {
      calls += 1;
      return { from: () => ({ where: () => Promise.resolve(rows) }) };
    },
  } as unknown as Database;
  return { db, calls: () => calls };
}

const identity = (kycTier: 0 | 1 | 2): FeatureVector =>
  ({ identity: { kycTier } }) as unknown as FeatureVector;
const phoneAge = (days: number): FeatureVector =>
  ({ identity: { phoneAgeDays: days } }) as unknown as FeatureVector;

describe('RulesetLoader.load', () => {
  it('assembles only the active rules and applies their configuration', async () => {
    const { db } = fakeDb([
      {
        rule_id: 'gate.phone_age',
        description: 'Custom phone gate',
        configuration: { minDays: 5 },
      },
      { rule_id: 'score.kyc_tier', description: '', configuration: { tier2: 500 } },
    ]);
    const ruleset = await new RulesetLoader(db).load('v-custom');

    expect(ruleset.version).toBe('v-custom');
    expect(ruleset.hardGates).toHaveLength(1);
    expect(ruleset.scoringRules).toHaveLength(1);
    expect(ruleset.exposureRules).toHaveLength(0);

    const gate = ruleset.hardGates[0]!;
    expect(gate.id).toBe('gate.phone_age');
    expect(gate.description).toBe('Custom phone gate');
    expect(gate.evaluate(phoneAge(10)).passed).toBe(true); // tuned minDays=5

    const kyc = ruleset.scoringRules[0]!;
    expect(kyc.description).toBe('Higher KYC tier = more trust'); // blank row → blueprint default
    expect(kyc.evaluate(identity(2)).points).toBe(500);
  });

  it('skips rows referencing an unknown rule id', async () => {
    const { db } = fakeDb([
      { rule_id: 'gate.phone_age', description: '', configuration: {} },
      { rule_id: 'gate.does_not_exist', description: '', configuration: {} },
    ]);
    const ruleset = await new RulesetLoader(db).load('v-custom');
    expect(ruleset.hardGates).toHaveLength(1);
    expect(ruleset.hardGates[0]!.id).toBe('gate.phone_age');
  });

  it('falls back to the built-in default when no active rows exist', async () => {
    const { db } = fakeDb([]);
    const ruleset = await new RulesetLoader(db).load('whatever');
    expect(ruleset).toBe(DEFAULT_RULESET);
    expect(ruleset.hardGates).toHaveLength(6);
  });
});

describe('RulesetLoader caching', () => {
  it('serves a cached ruleset within the TTL and re-reads after invalidate', async () => {
    const { db, calls } = fakeDb([
      { rule_id: 'gate.phone_age', description: '', configuration: {} },
    ]);
    const loader = new RulesetLoader(db, { cacheTtlMs: 10_000 });

    await loader.getRuleset('v-custom');
    await loader.getRuleset('v-custom');
    expect(calls()).toBe(1);

    loader.invalidate('v-custom');
    await loader.getRuleset('v-custom');
    expect(calls()).toBe(2);
  });
});
