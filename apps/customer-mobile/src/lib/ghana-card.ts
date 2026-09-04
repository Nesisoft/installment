/**
 * Client-side check on a Ghana Card number, mirroring the server's
 * `normalizeGhanaCard`.
 *
 * Accepts what a Ghanaian keyboard actually produces: `GHA-123456789-0`, lower
 * case, spaces instead of dashes, or the compact run. The server canonicalises
 * it again with the same rule and is the authority — this exists only so a typo
 * costs a keystroke rather than a photo upload and a rejection days later.
 */
const CARD_PATTERN = /^GHA[- ]?\d{9}[- ]?\d$/i;

export function isGhanaCardNumber(input: string): boolean {
  return CARD_PATTERN.test(input.trim());
}

/** `gha 123456789 0` -> `GHA-123456789-0`. Returns null if it is not one. */
export function normaliseGhanaCardNumber(input: string): string | null {
  const compact = input.trim().toUpperCase().replace(/[\s-]/g, '');
  const match = /^GHA(\d{9})(\d)$/.exec(compact);
  return match ? `GHA-${match[1]}-${match[2]}` : null;
}
