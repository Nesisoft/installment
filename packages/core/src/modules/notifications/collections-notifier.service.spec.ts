import { describe, expect, it, vi } from 'vitest';
import { CollectionsNotifierService } from './collections-notifier.service';

function deps(over: { customer?: Record<string, unknown>; plan?: Record<string, unknown> } = {}) {
  const plan = over.plan ?? { id: 'p1', customer_id: 'c1', outstanding_pesewas: 75_000 };
  const customer = over.customer ?? { id: 'c1', first_name: 'Ama', momo_phone: '0244000000' };
  const plans = { get: vi.fn(async () => plan) };
  const customers = { get: vi.fn(async () => customer) };
  const sendToCustomer = vi.fn(async () => ({ notification: { id: 'n1' }, status: 'sent' }));
  const svc = new CollectionsNotifierService(
    plans as never,
    customers as never,
    { sendToCustomer } as never,
  );
  return { svc, sendToCustomer };
}

describe('CollectionsNotifierService.notifyStageEntered', () => {
  it('texts the customer when the case enters soft_reminder', async () => {
    const { svc, sendToCustomer } = deps();
    await svc.notifyStageEntered({
      customerPlanId: 'p1',
      scheduleId: 's1',
      stage: 'soft_reminder',
    });
    expect(sendToCustomer).toHaveBeenCalledWith(
      expect.objectContaining({
        templateId: 'collections_soft_reminder',
        variables: { name: 'Ama', amount: '750.00' },
      }),
    );
  });

  it('texts firm_reminder, restriction_warning, and legal_threat', async () => {
    for (const stage of ['firm_reminder', 'restriction_warning', 'legal_threat'] as const) {
      const { svc, sendToCustomer } = deps();
      await svc.notifyStageEntered({ customerPlanId: 'p1', scheduleId: 's1', stage });
      expect(sendToCustomer).toHaveBeenCalledWith(
        expect.objectContaining({ templateId: `collections_${stage}` }),
      );
    }
  });

  it('stays silent on operational stages (agent_assigned, field_visit, write_off)', async () => {
    for (const stage of ['agent_assigned', 'field_visit', 'write_off'] as const) {
      const { svc, sendToCustomer } = deps();
      await svc.notifyStageEntered({ customerPlanId: 'p1', scheduleId: 's1', stage });
      expect(sendToCustomer).not.toHaveBeenCalled();
    }
  });

  it('skips a customer with no MoMo on file', async () => {
    const { svc, sendToCustomer } = deps({
      customer: { id: 'c1', first_name: 'Ama', momo_phone: null },
    });
    await svc.notifyStageEntered({
      customerPlanId: 'p1',
      scheduleId: 's1',
      stage: 'soft_reminder',
    });
    expect(sendToCustomer).not.toHaveBeenCalled();
  });

  it('never throws even if the lookup fails (best-effort)', async () => {
    const plans = {
      get: vi.fn(async () => {
        throw new Error('not found');
      }),
    };
    const sendToCustomer = vi.fn();
    const svc = new CollectionsNotifierService(
      plans as never,
      {} as never,
      {
        sendToCustomer,
      } as never,
    );
    await expect(
      svc.notifyStageEntered({ customerPlanId: 'p1', scheduleId: 's1', stage: 'soft_reminder' }),
    ).resolves.toBeUndefined();
    expect(sendToCustomer).not.toHaveBeenCalled();
  });
});
