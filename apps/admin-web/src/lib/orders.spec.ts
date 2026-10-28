import { describe, expect, it } from 'vitest';
import { orderActions } from './orders';

describe('orderActions', () => {
  it('confirms payment only on a pay-in-full order still waiting for it', () => {
    expect(orderActions({ status: 'pending_payment', payment_type: 'full' }).confirmPayment).toBe(
      true,
    );
    expect(
      orderActions({ status: 'pending_payment', payment_type: 'installment' }).confirmPayment,
    ).toBe(false);
    expect(orderActions({ status: 'paid', payment_type: 'full' }).confirmPayment).toBe(false);
  });

  it('cancels only an order nothing has been paid on', () => {
    for (const status of ['pending_payment', 'pending_approval', 'payment_failed'] as const) {
      expect(orderActions({ status, payment_type: 'full' }).cancel).toBe(true);
    }
    for (const status of ['paid', 'financing_active', 'shipped', 'delivered'] as const) {
      expect(orderActions({ status, payment_type: 'full' }).cancel).toBe(false);
    }
  });
});
