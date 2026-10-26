import { describe, expect, it } from 'vitest';
import { isPlaceholderEmail, placeholderEmailFor, realEmail } from './placeholder-email';

describe('placeholder email', () => {
  it('recognises the address phone signup stores', () => {
    const stored = placeholderEmailFor('+233244000000');
    expect(stored).toBe('+233244000000@customer.installment.local');
    expect(isPlaceholderEmail(stored)).toBe(true);
    expect(realEmail(stored)).toBeNull();
  });

  it('leaves a real address alone', () => {
    expect(isPlaceholderEmail('ama@example.com')).toBe(false);
    expect(realEmail('ama@example.com')).toBe('ama@example.com');
    // Only the signup domain itself, not anything that happens to end in .local.
    expect(isPlaceholderEmail('ama@installment.local')).toBe(false);
  });

  it('treats a missing email as no email', () => {
    expect(isPlaceholderEmail(null)).toBe(false);
    expect(realEmail(undefined)).toBeNull();
  });
});
