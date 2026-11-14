import { describe, expect, it } from 'vitest';
import { DEFAULT_RETURN_PATH, safeReturnPath } from './payment-return';

describe('safeReturnPath', () => {
  it('keeps a path inside the app', () => {
    expect(safeReturnPath('/confirmation/7b1c')).toBe('/confirmation/7b1c');
    expect(safeReturnPath(['/orders/9', '/ignored'])).toBe('/orders/9');
  });

  it('falls back to the orders list when there is nothing to go on', () => {
    expect(safeReturnPath(undefined)).toBe(DEFAULT_RETURN_PATH);
    expect(safeReturnPath('')).toBe(DEFAULT_RETURN_PATH);
  });

  it('refuses anything a browser would treat as another site', () => {
    for (const hostile of [
      'https://evil.example/pay',
      '//evil.example/pay',
      '/\\evil.example/pay',
      'javascript:alert(1)',
      '/redirect?to=https://evil.example',
      'confirmation/7b1c',
      '/orders\n/evil',
    ]) {
      expect(safeReturnPath(hostile)).toBe(DEFAULT_RETURN_PATH);
    }
  });
});
