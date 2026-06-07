import { describe, expect, it, vi } from 'vitest';
import { ReminderRunner } from './reminder-runner';

const installment = (
  over: Partial<{
    id: string;
    customer_plan_id: string;
    amount_due_pesewas: number;
    late_fee_pesewas: number;
  }> = {},
) => ({
  id: 's1',
  customer_plan_id: 'p1',
  amount_due_pesewas: 25_000,
  late_fee_pesewas: 0,
  ...over,
});

function deps(
  over: {
    due?: ReturnType<typeof installment>[];
    customer?: Record<string, unknown>;
    plan?: Record<string, unknown>;
    sendStatus?: 'sent' | 'failed';
    sendThrows?: Error;
  } = {},
) {
  const customer = over.customer ?? {
    id: 'c1',
    first_name: 'Ama',
    momo_phone: '0244000000',
    momo_provider: 'mtn',
  };
  const plan = over.plan ?? { id: 'p1', customer_id: 'c1' };
  const plans = {
    listDueOn: vi.fn(async () => over.due ?? [installment()]),
    get: vi.fn(async () => plan),
  };
  const customers = { get: vi.fn(async () => customer) };
  const sendToCustomer = vi.fn(async () => {
    if (over.sendThrows) throw over.sendThrows;
    return { notification: { id: 'n1' }, status: over.sendStatus ?? 'sent' };
  });
  const runner = new ReminderRunner(
    plans as never,
    customers as never,
    { sendToCustomer } as never,
  );
  return { runner, plans, customers, sendToCustomer };
}

describe('ReminderRunner.sendUpcomingReminders', () => {
  it('texts the pre-debit reminder for each due installment with the right variables', async () => {
    const { runner, sendToCustomer, plans } = deps();
    const summary = await runner.sendUpcomingReminders('2026-06-20');

    expect(plans.listDueOn).toHaveBeenCalledWith('2026-06-20', undefined);
    expect(sendToCustomer).toHaveBeenCalledWith(
      expect.objectContaining({
        templateId: 'pre_debit_reminder',
        toAddress: '0244000000',
        variables: {
          name: 'Ama',
          amount: '250.00',
          date: '2026-06-20',
          provider: 'mtn',
          phone: '0244000000',
        },
      }),
    );
    expect(summary).toEqual({ forDate: '2026-06-20', candidates: 1, sent: 1, skipped: 0 });
  });

  it('skips a customer with no MoMo on file (never SMSes)', async () => {
    const { runner, sendToCustomer } = deps({
      customer: { id: 'c1', first_name: 'Ama', momo_phone: null, momo_provider: null },
    });
    const summary = await runner.sendUpcomingReminders('2026-06-20');
    expect(sendToCustomer).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ candidates: 1, sent: 0, skipped: 1 });
  });

  it('counts a failed SMS as skipped (NotificationService records the failure)', async () => {
    const { runner } = deps({ sendStatus: 'failed' });
    const summary = await runner.sendUpcomingReminders('2026-06-20');
    expect(summary).toMatchObject({ sent: 0, skipped: 1 });
  });

  it('continues the sweep when one installment throws (best-effort)', async () => {
    const { runner, sendToCustomer } = deps({
      due: [installment({ id: 's1' }), installment({ id: 's2' })],
    });
    sendToCustomer.mockImplementationOnce(async () => {
      throw new Error('render failed');
    });
    sendToCustomer.mockImplementationOnce(async () => ({
      notification: { id: 'n2' },
      status: 'sent',
    }));

    const summary = await runner.sendUpcomingReminders('2026-06-20');
    expect(summary).toEqual({ forDate: '2026-06-20', candidates: 2, sent: 1, skipped: 1 });
  });

  it('passes a custom limit through to the repository', async () => {
    const { runner, plans } = deps({ due: [] });
    await runner.sendUpcomingReminders('2026-06-20', { limit: 50 });
    expect(plans.listDueOn).toHaveBeenCalledWith('2026-06-20', 50);
  });
});
