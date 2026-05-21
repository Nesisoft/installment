import { describe, expect, it } from 'vitest';
import {
  IllegalEmployerTransitionError,
  IllegalEmploymentTransitionError,
  nextEmployerStatus,
  nextEmploymentStatus,
} from './state-machine';

describe('employer state machine', () => {
  it('allows the canonical happy path and termination', () => {
    expect(nextEmployerStatus('pending', 'activate')).toBe('active');
    expect(nextEmployerStatus('active', 'pause')).toBe('paused');
    expect(nextEmployerStatus('paused', 'resume')).toBe('active');
    expect(nextEmployerStatus('active', 'terminate')).toBe('terminated');
    expect(nextEmployerStatus('paused', 'terminate')).toBe('terminated');
  });

  it('refuses to leave terminated', () => {
    expect(() => nextEmployerStatus('terminated', 'activate')).toThrow(
      IllegalEmployerTransitionError,
    );
    expect(() => nextEmployerStatus('terminated', 'resume')).toThrow(
      IllegalEmployerTransitionError,
    );
  });

  it('refuses illegal events on intermediate states', () => {
    expect(() => nextEmployerStatus('pending', 'pause')).toThrow(IllegalEmployerTransitionError);
    expect(() => nextEmployerStatus('active', 'activate')).toThrow(IllegalEmployerTransitionError);
  });
});

describe('employment state machine', () => {
  it('walks active ↔ on_leave / suspended and rejoins from left_employer', () => {
    expect(nextEmploymentStatus('active', 'take_leave')).toBe('on_leave');
    expect(nextEmploymentStatus('on_leave', 'return_from_leave')).toBe('active');
    expect(nextEmploymentStatus('active', 'suspend')).toBe('suspended');
    expect(nextEmploymentStatus('suspended', 'reinstate')).toBe('active');
    expect(nextEmploymentStatus('active', 'leave_employer')).toBe('left_employer');
    expect(nextEmploymentStatus('left_employer', 'rejoin')).toBe('active');
  });

  it('refuses illegal employment transitions', () => {
    expect(() => nextEmploymentStatus('left_employer', 'take_leave')).toThrow(
      IllegalEmploymentTransitionError,
    );
    expect(() => nextEmploymentStatus('on_leave', 'leave_employer')).toThrow(
      IllegalEmploymentTransitionError,
    );
    expect(() => nextEmploymentStatus('active', 'reinstate')).toThrow(
      IllegalEmploymentTransitionError,
    );
  });
});
