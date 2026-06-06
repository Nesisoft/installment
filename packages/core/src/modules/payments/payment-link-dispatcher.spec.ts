import { describe, expect, it, vi } from 'vitest';
import { PaymentLinkDispatcher } from './payment-link-dispatcher';

function deps(
  over: {
    customer?: Record<string, unknown>;
    installment?: Record<string, unknown>;
    createThrows?: Error;
    notifyStatus?: 'sent' | 'failed';
  } = {},
) {
  const installment = over.installment ?? {
    id: 's1',
    customer_plan_id: 'p1',
    amount_due_pesewas: 25_000,
    late_fee_pesewas: 0,
  };
  const customer = over.customer ?? {
    id: 'c1',
    email: 'a@x.gh',
    first_name: 'Ama',
    momo_phone: '0244000000',
  };
  const plans = {
    getInstallment: vi.fn(async () => installment),
    get: vi.fn(async () => ({ id: 'p1', customer_id: 'c1' })),
  };
  const customers = { get: vi.fn(async () => customer) };
  const attempts = { create: vi.fn(async () => ({ id: 'att-1' })) };
  const notifications = {
    sendToCustomer: vi.fn(async () => ({
      notification: { id: 'n1' },
      status: over.notifyStatus ?? 'sent',
    })),
  };
  const paystack = {
    createPaymentLink: vi.fn(async () => {
      if (over.createThrows) throw over.createThrows;
      return { data: { authorization_url: 'https://paystack/pay/abc', reference: 'LINK-s1-4' } };
    }),
  };
  const dispatcher = new PaymentLinkDispatcher(
    plans as never,
    customers as never,
    attempts as never,
    notifications as never,
    paystack as never,
  );
  return { dispatcher, plans, customers, attempts, notifications, paystack };
}

describe('PaymentLinkDispatcher.dispatch', () => {
  it('creates a link, logs the attempt, and SMSes it to the customer', async () => {
    const { dispatcher, attempts, notifications, paystack } = deps();

    const outcome = await dispatcher.dispatch('s1', 4);

    expect(paystack.createPaymentLink).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'a@x.gh', amount: 25_000, reference: 'LINK-s1-4' }),
    );
    expect(attempts.create).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'payment_link', idempotencyKey: 'LINK-s1-4' }),
    );
    expect(notifications.sendToCustomer).toHaveBeenCalledWith(
      expect.objectContaining({
        templateId: 'payment_link',
        variables: expect.objectContaining({
          name: 'Ama',
          amount: '250.00',
          url: 'https://paystack/pay/abc',
        }),
      }),
    );
    expect(outcome).toMatchObject({
      scheduleId: 's1',
      status: 'sent',
      url: 'https://paystack/pay/abc',
    });
  });

  it('skips when the customer has no phone (never creates a link)', async () => {
    const { dispatcher, paystack } = deps({
      customer: { id: 'c1', email: 'a@x.gh', first_name: 'Ama', momo_phone: null },
    });
    const outcome = await dispatcher.dispatch('s1', 4);
    expect(outcome.status).toBe('skipped');
    expect(outcome.reason).toBe('no_phone_on_file');
    expect(paystack.createPaymentLink).not.toHaveBeenCalled();
  });

  it('reports failed (and books no attempt) when link creation throws', async () => {
    const { dispatcher, attempts } = deps({ createThrows: new Error('paystack 502') });
    const outcome = await dispatcher.dispatch('s1', 4);
    expect(outcome.status).toBe('failed');
    expect(outcome.reason).toBe('paystack 502');
    expect(attempts.create).not.toHaveBeenCalled();
  });

  it('reports failed when the SMS could not be sent (link still created)', async () => {
    const { dispatcher } = deps({ notifyStatus: 'failed' });
    const outcome = await dispatcher.dispatch('s1', 4);
    expect(outcome.status).toBe('failed');
    expect(outcome.reason).toBe('sms_failed');
    expect(outcome.url).toBe('https://paystack/pay/abc');
  });
});
