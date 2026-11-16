/**
 * The rules a new password has to meet, as one plain function so the reset and
 * change screens say the same thing and the rules can be tested in node.
 *
 * The same rules as the server's: 8 to 200 characters, and on a change, not
 * the current password. The confirmation is the app's own: a password typed
 * into a dot-masked field once is a password that may have a typo in it.
 */

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;

/** What is wrong with a new password and its confirmation, or `null` if nothing. */
export function newPasswordProblem(next: string, confirm: string, current?: string): string | null {
  if (next.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (next.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  if (current !== undefined && next === current) {
    return 'Choose a password different from your current one.';
  }
  if (next !== confirm) return 'The two passwords do not match.';
  return null;
}
