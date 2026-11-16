import { describe, expect, it } from 'vitest';
import { PASSWORD_MAX, newPasswordProblem } from './password';

describe('newPasswordProblem', () => {
  it('accepts a long-enough password typed the same twice', () => {
    expect(newPasswordProblem('kente-and-cloth', 'kente-and-cloth')).toBeNull();
    expect(newPasswordProblem('kente-and-cloth', 'kente-and-cloth', 'old-password')).toBeNull();
  });

  it('refuses one that is too short or too long, as the server would', () => {
    expect(newPasswordProblem('short', 'short')).toMatch(/at least 8/);
    const long = 'x'.repeat(PASSWORD_MAX + 1);
    expect(newPasswordProblem(long, long)).toMatch(/at most 200/);
  });

  it('refuses keeping the current password on a change', () => {
    expect(newPasswordProblem('same-as-before', 'same-as-before', 'same-as-before')).toMatch(
      /different from your current one/,
    );
  });

  it('catches a typo in the confirmation', () => {
    expect(newPasswordProblem('kente-and-cloth', 'kente-and-clotj')).toMatch(/do not match/);
  });
});
