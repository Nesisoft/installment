import type { Rule, Ruleset } from './types';
import { RULE_LIBRARY, buildRule } from './rule-library';

/**
 * The built-in ruleset, assembled from {@link RULE_LIBRARY} with each rule's
 * default configuration. In production a Ruleset can instead be assembled from
 * the rule_definitions table for hot-reload (see RulesetLoader); ScoringEngine
 * accepts one via its constructor.
 */
export const RULESET_VERSION = 'v1.0.0';

const DEFAULT_RULES: Rule[] = RULE_LIBRARY.map((blueprint) => buildRule(blueprint));

export const HARD_GATES: Rule[] = DEFAULT_RULES.filter((r) => r.category === 'hard_gate');
export const SCORING_RULES: Rule[] = DEFAULT_RULES.filter((r) => r.category === 'score');
export const EXPOSURE_RULES: Rule[] = DEFAULT_RULES.filter((r) => r.category === 'exposure');

export const DEFAULT_RULESET: Ruleset = {
  version: RULESET_VERSION,
  hardGates: HARD_GATES,
  scoringRules: SCORING_RULES,
  exposureRules: EXPOSURE_RULES,
};
