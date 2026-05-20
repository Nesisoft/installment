import { z } from 'zod';

/**
 * Ghana-specific input validators (DEVELOPMENT-PLAN.md §2 Phase 2 task 9).
 *
 * Each schema also has a paired `normalize*` helper so non-Zod call sites can
 * reuse the same canonicalization logic.
 */

// ---------------------------------------------------------------------------
// Mobile phone numbers — canonicalized to E.164 (+233XXXXXXXXX)
// ---------------------------------------------------------------------------

const GH_E164 = /^\+233[25]\d{8}$/;

/**
 * Accepts 0XXXXXXXXX (10 digits), 233XXXXXXXXX (12 digits), or +233XXXXXXXXX
 * with internal whitespace/dashes. Returns the canonical E.164 form or null
 * when the number is not a valid Ghanaian mobile (prefix 02x or 05x).
 */
export function normalizeGhPhone(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (!raw) return null;

  const hasPlus = raw.startsWith('+');
  const digits = raw.replace(/\D/g, '');

  let canonical: string | null = null;
  if (hasPlus) {
    if (digits.length === 12 && digits.startsWith('233')) canonical = `+${digits}`;
  } else if (digits.length === 12 && digits.startsWith('233')) {
    canonical = `+${digits}`;
  } else if (digits.length === 10 && digits.startsWith('0')) {
    canonical = `+233${digits.slice(1)}`;
  }

  return canonical && GH_E164.test(canonical) ? canonical : null;
}

export const ghPhoneNumber = z.string().transform((value, ctx) => {
  const normalized = normalizeGhPhone(value);
  if (!normalized) {
    ctx.addIssue({
      code: 'custom',
      message: 'Invalid Ghanaian mobile phone number',
    });
    return z.NEVER;
  }
  return normalized;
});

// ---------------------------------------------------------------------------
// Ghana Card numbers — canonical form GHA-XXXXXXXXX-X
// ---------------------------------------------------------------------------

const GHANA_CARD_INPUT = /^GHA[- ]?(\d{9})[- ]?(\d)$/;

/**
 * Accepts case-insensitive `GHA-123456789-0`, `gha 123456789 0`, or compact
 * `GHA1234567890`. Returns canonical `GHA-XXXXXXXXX-X` or null.
 */
export function normalizeGhanaCard(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const s = input.trim().toUpperCase().replace(/\s+/g, '');
  const m = GHANA_CARD_INPUT.exec(s);
  if (!m) return null;
  return `GHA-${m[1]}-${m[2]}`;
}

export const ghanaCardNumber = z.string().transform((value, ctx) => {
  const normalized = normalizeGhanaCard(value);
  if (!normalized) {
    ctx.addIssue({
      code: 'custom',
      message: 'Invalid Ghana Card number (expected GHA-XXXXXXXXX-X)',
    });
    return z.NEVER;
  }
  return normalized;
});

// ---------------------------------------------------------------------------
// MoMo provider codes — matches customers.momo_provider CHECK constraint
// ---------------------------------------------------------------------------

export const MOMO_PROVIDER_CODES = ['mtn', 'tgo', 'vod'] as const;
export type MomoProviderCode = (typeof MOMO_PROVIDER_CODES)[number];

export const momoProviderCode = z.enum(MOMO_PROVIDER_CODES);
