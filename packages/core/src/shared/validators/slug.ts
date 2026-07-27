import { z } from 'zod';

/**
 * Lowercase kebab-case slug: `a-z`, `0-9`, hyphen-separated, no leading/trailing
 * or doubled hyphens. Mirrors the `~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'` CHECK on
 * stores.slug / categories.slug (migration 0005), so an accepted value never
 * trips the DB constraint.
 */
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(SLUG_RE, 'must be lowercase kebab-case (a-z, 0-9, hyphen-separated)');
