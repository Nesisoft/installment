/**
 * Postgres error helpers. Drizzle wraps the driver error under `.cause`, but a
 * raw driver error can also surface directly, so we look in both places.
 */

/** SQLSTATE 23505 — unique_violation. */
const UNIQUE_VIOLATION = '23505';

interface PgErrorLike {
  code?: string;
  constraint?: string;
}

function pgError(err: unknown): PgErrorLike | undefined {
  const e = err as { code?: string; constraint?: string; cause?: PgErrorLike } | undefined;
  if (e?.code) return e;
  return e?.cause;
}

/**
 * True when `err` is a Postgres unique-constraint violation. Pass `constraint`
 * to match a specific constraint name (e.g. 'stores_slug_key') so a service can
 * tell which uniqueness failed and raise the right typed error.
 */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const pg = pgError(err);
  if (pg?.code !== UNIQUE_VIOLATION) return false;
  return constraint === undefined || pg.constraint === constraint;
}
