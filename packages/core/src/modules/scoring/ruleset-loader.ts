import { and, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import type { Rule, Ruleset } from './types';
import { DEFAULT_RULESET, RULESET_VERSION } from './ruleset';
import { RULE_LIBRARY } from './rule-library';

const rd = schema.rule_definitions;

export interface RulesetLoaderOptions {
  /** How long a loaded ruleset is cached before the next read. Default 60s. */
  cacheTtlMs?: number;
}

function asConfig(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Assembles a {@link Ruleset} from the `rule_definitions` table so weights and
 * rule activation can change without a deploy. Rule *logic* always comes from
 * {@link RULE_LIBRARY} (the DB never supplies executable code); a row only
 * activates a known rule and tunes its configuration. Reads are cached for a
 * short TTL — call {@link invalidate} to pick up a change immediately. When a
 * version has no active rows, the built-in {@link DEFAULT_RULESET} is returned.
 */
export class RulesetLoader {
  private readonly cache = new Map<string, { ruleset: Ruleset; expiresAt: number }>();
  private readonly ttlMs: number;

  constructor(
    private readonly db: Database,
    opts: RulesetLoaderOptions = {},
  ) {
    this.ttlMs = opts.cacheTtlMs ?? 60_000;
  }

  /** Fresh read + assembly (bypasses the cache). */
  async load(version: string = RULESET_VERSION): Promise<Ruleset> {
    // Compare against the DB clock (microsecond `now()`), not Node's millisecond
    // `toISOString()` — otherwise an INSERT defaulting `effective_from` to DB-side
    // now() and a SELECT in the same millisecond can race, wrongly excluding the row.
    const rows = await this.db
      .select({
        rule_id: rd.rule_id,
        description: rd.description,
        configuration: rd.configuration,
      })
      .from(rd)
      .where(
        and(
          eq(rd.ruleset_version, version),
          eq(rd.is_active, true),
          lte(rd.effective_from, sql`now()`),
          or(isNull(rd.effective_to), gt(rd.effective_to, sql`now()`)),
        ),
      );

    if (rows.length === 0) return DEFAULT_RULESET;

    const byId = new Map(rows.map((r) => [r.rule_id, r] as const));
    const hardGates: Rule[] = [];
    const scoringRules: Rule[] = [];
    const exposureRules: Rule[] = [];

    // Iterate the library in canonical order; include only active rules.
    for (const blueprint of RULE_LIBRARY) {
      const row = byId.get(blueprint.id);
      if (!row) continue;
      const rule: Rule = {
        id: blueprint.id,
        category: blueprint.category,
        description: row.description || blueprint.description,
        evaluate: blueprint.build(asConfig(row.configuration)),
      };
      const bucket =
        blueprint.category === 'hard_gate'
          ? hardGates
          : blueprint.category === 'score'
            ? scoringRules
            : exposureRules;
      bucket.push(rule);
    }

    return { version, hardGates, scoringRules, exposureRules };
  }

  /** Cached read; refreshes after the configured TTL. */
  async getRuleset(version: string = RULESET_VERSION): Promise<Ruleset> {
    const hit = this.cache.get(version);
    if (hit && hit.expiresAt > Date.now()) return hit.ruleset;
    const ruleset = await this.load(version);
    this.cache.set(version, { ruleset, expiresAt: Date.now() + this.ttlMs });
    return ruleset;
  }

  /** Drop cached rulesets so the next read reflects DB changes immediately. */
  invalidate(version?: string): void {
    if (version) this.cache.delete(version);
    else this.cache.clear();
  }
}
