/**
 * Collections dunning stages (ported from the design's state-machine notes:
 * default threshold is ~90 days in collections). A case progresses through
 * these in order as it ages; each stage's number is the case age in days at
 * which it becomes active. Pure data + helpers — no I/O.
 */
export const COLLECTIONS_STAGES = [
  'soft_reminder',
  'firm_reminder',
  'restriction_warning',
  'agent_assigned',
  'field_visit',
  'legal_threat',
  'write_off',
] as const;

export type CollectionsStage = (typeof COLLECTIONS_STAGES)[number];

/** Case age (days since opened) at which each stage becomes active. */
export const STAGE_AGE_DAYS: Record<CollectionsStage, number> = {
  soft_reminder: 0,
  firm_reminder: 3,
  restriction_warning: 7,
  agent_assigned: 14,
  field_visit: 30,
  legal_threat: 60,
  write_off: 90,
};

const ORDER: Record<CollectionsStage, number> = COLLECTIONS_STAGES.reduce(
  (acc, stage, i) => {
    acc[stage] = i;
    return acc;
  },
  {} as Record<CollectionsStage, number>,
);

/** The furthest stage whose age threshold has been reached at `ageDays`. */
export function stageForAge(ageDays: number): CollectionsStage {
  let result: CollectionsStage = 'soft_reminder';
  for (const stage of COLLECTIONS_STAGES) {
    if (ageDays >= STAGE_AGE_DAYS[stage]) result = stage;
  }
  return result;
}

/** True when `candidate` is strictly further along than `current`. */
export function isLaterStage(candidate: CollectionsStage, current: CollectionsStage): boolean {
  return ORDER[candidate] > ORDER[current];
}

/** Stage ordinal (0 = soft_reminder … 6 = write_off). */
export function stageOrder(stage: CollectionsStage): number {
  return ORDER[stage];
}

/** write_off is terminal — the case can't escalate further. */
export function isTerminalStage(stage: CollectionsStage): boolean {
  return stage === 'write_off';
}
