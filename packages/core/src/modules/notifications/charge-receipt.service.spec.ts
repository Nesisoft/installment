import { describe, expect, it, vi } from 'vitest';
import { ChargeReceiptService } from './charge-receipt.service';

function deps(over: { customer?: Record<string, unknown>; plan?: Record<string, unknown> } = {}) {
  const installment = { id: 's1', customer_plan_id: 'p1' };
  const plan = over.plan ?? { id: 'p1', customer_id: 'c1', outstanding_pesewas: 75_000 };
  const customer = over.customer ?? { id: 'c1', first_name: 'Ama', momo_phone: '0244000000' };
  const plans = {
    getInstallment: vi.fn(async () => installment),
    get: vi.fn(async () => plan),
  };
  const customers = { get: vi.fn(async () => customer) };
  const sendToCustomer = vi.fn(async () => ({ notification: { id: 'n1' }, status: 'sent' }));
  const svc = new ChargeReceiptService(
    plans as never,
    customers as never,
    {
      sendToCustomer,
    } as never,
  );
  return { svc, sendToCustomer };
}

describe('ChargeReceiptService', () => {
  it('sends the success receipt with amount + outstanding', async () => {
    const { svc, sendToCustomer } = deps();
    await svc.notifyChargeSucceeded('s1', 25_000);
    expect(sendToCustomer).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: 'c1',
        toAddress: '0244000000',
        templateId: 'payment_succeeded',
        variables: { name: 'Ama', amount: '250.00', outstanding: '750.00' },
      }),
    );
  });

  it('sends the failure receipt with the amount', async () => {
    const { svc, sendToCustomer } = deps();
    await svc.notifyChargeFailed('s1', 25_000);
    expect(sendToCustomer).toHaveBeenCalledWith(
      expect.objectContaining({
        templateId: 'payment_failed',
        variables: { name: 'Ama', amount: '250.00' },
      }),
    );
  });

  // A customer who pays by card got no receipt and no failure notice.
  it('sends receipts to the account phone when no wallet is on file', async () => {
    const { svc, sendToCustomer } = deps({
      customer: { id: 'c1', first_name: 'Ama', momo_phone: null, phone: '+233200000000' },
    });
    await svc.notifyChargeSucceeded('s1', 25_000);
    await svc.notifyChargeFailed('s1', 25_000);
    expect(sendToCustomer).toHaveBeenCalledTimes(2);
    for (const [args] of sendToCustomer.mock.calls as unknown as [{ toAddress: string }][]) {
      expect(args.toAddress).toBe('+233200000000');
    }
  });

  it('skips when the customer has no number at all', async () => {
    const { svc, sendToCustomer } = deps({
      customer: { id: 'c1', first_name: 'Ama', momo_phone: null, phone: null },
    });
    await svc.notifyChargeSucceeded('s1', 25_000);
    expect(sendToCustomer).not.toHaveBeenCalled();
  });

  it('never throws even if the lookup fails (best-effort)', async () => {
    const plans = {
      getInstallment: vi.fn(async () => {
        throw new Error('not found');
      }),
      get: vi.fn(),
    };
    const sendToCustomer = vi.fn();
    const svc = new ChargeReceiptService(
      plans as never,
      {} as never,
      {
        sendToCustomer,
      } as never,
    );
    await expect(svc.notifyChargeSucceeded('missing', 1)).resolves.toBeUndefined();
    expect(sendToCustomer).not.toHaveBeenCalled();
  });
});
