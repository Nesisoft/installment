import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestDb, schema } from '@installment/db';
import { RulesetLoader } from './ruleset-loader';
import { DEFAULT_RULESET } from './ruleset';
import type { FeatureVector } from './types';

const RUN_DB = Boolean(process.env.DATABASE_URL);

const kyc = (tier: 0 | 1 | 2): FeatureVector =>
  ({ identity: { kycTier: tier } }) as unknown as FeatureVector;
const velocity = (count: number): FeatureVector =>
  ({ exposure: { applicationsLast24h: count } }) as unknown as FeatureVector;

describe.skipIf(!RUN_DB)('RulesetLoader (integration)', () => {
  const { db, pool } = createTestDb();
  const loader = new RulesetLoader(db);
  const rd = schema.rule_definitions;

  afterAll(async () => {
    await pool.end();
  });

  /**
   * A version with rows but no hard gates must not run ungated.
   *
   * `load()` falls back to DEFAULT_RULESET only when the version has *no*
   * active rows. One active row is enough to take the assembly path, and if
   * none of the active rows is a gate, `hardGates` comes back empty — and the
   * engine's Stage 1 loop then iterates nothing, so a blocklisted customer
   * with a recent default and no Ghana card passes every gate. Building a new
   * ruleset version row by row passes straight through that state.
   */
  it('falls back rather than returning a ruleset with no hard gates', async () => {
    const version = `v-nogates-${randomUUID()}`;
    await db.insert(rd).values([
      {
        ruleset_version: version,
        rule_id: 'score.kyc_tier',
        category: 'score',
        description: 'KYC only — no gates activated yet',
        configuration: { tier1: 50, tier2: 100 },
      },
    ]);

    const ruleset = await loader.load(version);
    expect(ruleset.hardGates.length).toBeGreaterThan(0);
    expect(ruleset.hardGates.map((r) => r.id)).toEqual(DEFAULT_RULESET.hardGates.map((r) => r.id));
  });

  it('assembles a tuned ruleset from active rows and excludes inactive ones', async () => {
    const version = `v-test-${randomUUID()}`;
    await db.insert(rd).values([
      {
        ruleset_version: version,
        rule_id: 'gate.ghana_card_verified',
        category: 'hard_gate',
        description: 'GC',
        configuration: {},
      },
      {
        ruleset_version: version,
        rule_id: 'score.kyc_tier',
        category: 'score',
        description: 'KYC',
        configuration: { tier1: 999, tier2: 1000 },
      },
      {
        ruleset_version: version,
        rule_id: 'exposure.velocity',
        category: 'exposure',
        description: 'V',
        configuration: { maxPer24h: 1 },
      },
      {
        ruleset_version: version,
        rule_id: 'score.no_prior_defaults',
        category: 'score',
        description: 'inactive',
        configuration: {},
        is_active: false,
      },
    ]);

    const ruleset = await loader.load(version);

    expect(ruleset.version).toBe(version);
    expect(ruleset.hardGates.map((r) => r.id)).toEqual(['gate.ghana_card_verified']);
    expect(ruleset.scoringRules.map((r) => r.id)).toEqual(['score.kyc_tier']);
    expect(ruleset.exposureRules.map((r) => r.id)).toEqual(['exposure.velocity']);

    // Configuration from the row is applied to the rebuilt evaluator.
    expect(ruleset.scoringRules[0]!.evaluate(kyc(1)).points).toBe(999);
    expect(ruleset.exposureRules[0]!.evaluate(velocity(1)).passed).toBe(false);
  });

  it('falls back to the built-in default for an unseeded version', async () => {
    const ruleset = await loader.load(`unknown-${randomUUID()}`);
    expect(ruleset).toBe(DEFAULT_RULESET);
  });

  it('excludes rows outside their effective window', async () => {
    const version = `v-eff-${randomUUID()}`;
    const past = new Date(Date.now() - 86_400_000).toISOString();
    await db.insert(rd).values([
      {
        ruleset_version: version,
        rule_id: 'gate.phone_age',
        category: 'hard_gate',
        description: 'active',
        configuration: {},
      },
      {
        ruleset_version: version,
        rule_id: 'gate.not_blocklisted',
        category: 'hard_gate',
        description: 'expired',
        configuration: {},
        effective_to: past,
      },
    ]);

    const ruleset = await loader.load(version);
    expect(ruleset.hardGates.map((r) => r.id)).toEqual(['gate.phone_age']);
  });
});
