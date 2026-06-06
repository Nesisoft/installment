import { describe, expect, it } from 'vitest';
import {
  COLLECTIONS_STAGES,
  isLaterStage,
  isTerminalStage,
  stageForAge,
  stageOrder,
} from './stage-policy';

describe('collections stage policy', () => {
  it('maps case age to the furthest reached stage', () => {
    expect(stageForAge(0)).toBe('soft_reminder');
    expect(stageForAge(2)).toBe('soft_reminder');
    expect(stageForAge(3)).toBe('firm_reminder');
    expect(stageForAge(7)).toBe('restriction_warning');
    expect(stageForAge(13)).toBe('restriction_warning');
    expect(stageForAge(14)).toBe('agent_assigned');
    expect(stageForAge(30)).toBe('field_visit');
    expect(stageForAge(60)).toBe('legal_threat');
    expect(stageForAge(90)).toBe('write_off');
    expect(stageForAge(365)).toBe('write_off'); // clamps at terminal
  });

  it('orders stages and detects forward movement', () => {
    expect(stageOrder('soft_reminder')).toBe(0);
    expect(stageOrder('write_off')).toBe(COLLECTIONS_STAGES.length - 1);
    expect(isLaterStage('firm_reminder', 'soft_reminder')).toBe(true);
    expect(isLaterStage('soft_reminder', 'firm_reminder')).toBe(false);
    expect(isLaterStage('agent_assigned', 'agent_assigned')).toBe(false);
  });

  it('flags only write_off as terminal', () => {
    expect(isTerminalStage('write_off')).toBe(true);
    expect(isTerminalStage('legal_threat')).toBe(false);
  });
});
