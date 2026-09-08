import { z } from 'zod';

/** `YYYY-MM-DD`, the only date shape any surface in this system accepts. */
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The youngest a person may be and still open an account. */
export const MINIMUM_AGE_YEARS = 18;

/** A sanity ceiling: past this, the date is a typo, not a customer. */
const MAXIMUM_AGE_YEARS = 120;

export const isoDate = z.string().regex(ISO_DATE_RE, 'expected YYYY-MM-DD');

/** Whole years between `from` and `now`, the way an age is counted. */
export function yearsSince(from: Date, now: Date = new Date()): number {
  let years = now.getUTCFullYear() - from.getUTCFullYear();
  const monthDelta = now.getUTCMonth() - from.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < from.getUTCDate())) years -= 1;
  return years;
}

/**
 * A date of birth that can open a credit account.
 *
 * This exists because of a hole that shipped: `gate.age_range` is a HARD GATE
 * and it declines on an age it does not know —
 * `age !== null && age >= minAge && age <= maxAge`, with the reason "Age out of
 * range or unknown" (`scoring/rule-library.ts`). `identity.collector` derives
 * that age from `customers.date_of_birth` and nothing else. And until this,
 * `date_of_birth` was on the ADMIN create/update schemas only: not on signup,
 * not on the Ghana Card submission, not on the shopper's own profile edit. So
 * every self-signed-up customer carried a NULL birthday and was declined for
 * instalments — the product's entire point — on the first hard gate.
 *
 * Nothing caught it because the orders integration specs approve the
 * application by hand (`applications.recordDecision({outcome: 'approved'})`)
 * rather than letting the engine decide, so no test ever put a real signup
 * through a real scoring run.
 *
 * The 18 here is not the credit rule — `gate.age_range` owns that, and its
 * bounds are configurable per ruleset. It is the account rule: signup already
 * demands `credit_scoring` consent to open an account at all, and a minor
 * cannot give it. The upper bound is a typo guard, not a policy.
 */
export const adultDateOfBirth = isoDate.superRefine((value, ctx) => {
  // `Date.parse` on `YYYY-MM-DD` is UTC midnight, which is what we want — a
  // birthday is a calendar date, not an instant, and running it through a local
  // timezone would shift it a day either side of the line.
  const born = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(born.getTime())) {
    ctx.addIssue({ code: 'custom', message: 'That is not a real date' });
    return;
  }
  // Rejects 2026-02-30, which the regex accepts and Date rolls forward to
  // March. A rolled date would silently register a different birthday.
  if (born.toISOString().slice(0, 10) !== value) {
    ctx.addIssue({ code: 'custom', message: 'That is not a real date' });
    return;
  }
  const age = yearsSince(born);
  if (age < 0) {
    ctx.addIssue({ code: 'custom', message: 'A date of birth cannot be in the future' });
    return;
  }
  if (age < MINIMUM_AGE_YEARS) {
    ctx.addIssue({
      code: 'custom',
      message: `You must be at least ${MINIMUM_AGE_YEARS} to open an Ejua account`,
    });
    return;
  }
  if (age > MAXIMUM_AGE_YEARS) {
    ctx.addIssue({ code: 'custom', message: 'Check the year — that date is too far back' });
  }
});
