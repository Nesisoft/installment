import { describe, expect, it, vi } from 'vitest';
import { cardLabel, ReminderRunner } from './reminder-runner';

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
    /** A usable saved card; undefined means the runner gets no card service. */
    card?: { brand: string | null; last4: string | null } | null;
  } = {},
) {
  const customer = over.customer ?? {
    id: 'c1',
    first_name: 'Ama',
    phone: '+233200000001',
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
  const cards =
    over.card === undefined ? undefined : { findUsable: vi.fn(async () => over.card ?? null) };
  const runner = new ReminderRunner(
    plans as never,
    customers as never,
    { sendToCustomer } as never,
    cards as never,
  );
  return { runner, plans, customers, sendToCustomer, cards };
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

  it('tells a customer with a saved card about the card, at their account phone', async () => {
    // The debit tries the card first, so this is the instrument it will charge —
    // even for a customer who also has a MoMo number on file.
    const { runner, sendToCustomer, cards } = deps({
      card: { brand: 'visa', last4: '4081' },
    });
    const summary = await runner.sendUpcomingReminders('2026-06-20');

    // Checked for the day it will be charged, not the day the reminder runs.
    expect(cards!.findUsable).toHaveBeenCalledWith('c1', new Date('2026-06-20T12:00:00Z'));
    expect(sendToCustomer).toHaveBeenCalledWith(
      expect.objectContaining({
        templateId: 'pre_debit_reminder_card',
        toAddress: '+233200000001',
        variables: {
          name: 'Ama',
          amount: '250.00',
          date: '2026-06-20',
          card: 'Visa card ending 4081',
        },
      }),
    );
    expect(summary).toMatchObject({ sent: 1, skipped: 0 });
  });

  it('reminds a card-only customer, who used to hear nothing', async () => {
    const { runner, sendToCustomer } = deps({
      customer: {
        id: 'c1',
        first_name: 'Ama',
        phone: '+233200000001',
        momo_phone: null,
        momo_provider: null,
      },
      card: { brand: 'mastercard', last4: '5559' },
    });
    await runner.sendUpcomingReminders('2026-06-20');
    expect(sendToCustomer).toHaveBeenCalledWith(
      expect.objectContaining({
        templateId: 'pre_debit_reminder_card',
        toAddress: '+233200000001',
      }),
    );
  });

  it('tells a customer with nothing on file to pay in the app', async () => {
    // Nothing will collect it for them, so this text is what stands between the
    // instalment and a late fee.
    const { runner, sendToCustomer } = deps({
      customer: {
        id: 'c1',
        first_name: 'Ama',
        phone: '+233200000001',
        momo_phone: null,
        momo_provider: null,
      },
      card: null,
    });
    const summary = await runner.sendUpcomingReminders('2026-06-20');
    expect(sendToCustomer).toHaveBeenCalledWith(
      expect.objectContaining({
        templateId: 'pre_debit_reminder_manual',
        toAddress: '+233200000001',
        variables: { name: 'Ama', amount: '250.00', date: '2026-06-20' },
      }),
    );
    expect(summary).toMatchObject({ sent: 1, skipped: 0 });
  });

  it('tells a customer who switched automatic collection off to pay in the app', async () => {
    // `listDueForAutoDebit` skips the plan, so nothing will be charged — the
    // card and wallet on file are irrelevant, and promising either is a lie
    // that ends in a late fee.
    const { runner, sendToCustomer, cards } = deps({
      plan: { id: 'p1', customer_id: 'c1', autopay_enabled: false },
      card: { brand: 'visa', last4: '4081' },
    });
    await runner.sendUpcomingReminders('2026-06-20');
    expect(cards!.findUsable).not.toHaveBeenCalled();
    expect(sendToCustomer).toHaveBeenCalledWith(
      expect.objectContaining({
        templateId: 'pre_debit_reminder_manual',
        toAddress: '+233200000001',
      }),
    );
  });

  it('does not tell an autopay-off customer to fund their wallet either', async () => {
    const { runner, sendToCustomer } = deps({
      plan: { id: 'p1', customer_id: 'c1', autopay_enabled: false },
    });
    await runner.sendUpcomingReminders('2026-06-20');
    expect(sendToCustomer).toHaveBeenCalledWith(
      expect.objectContaining({ templateId: 'pre_debit_reminder_manual' }),
    );
  });

  it('keeps to the MoMo reminder when the card lookup fails', async () => {
    const { runner, sendToCustomer, cards } = deps({ card: null });
    cards!.findUsable.mockRejectedValueOnce(new Error('db down'));
    await runner.sendUpcomingReminders('2026-06-20');
    expect(sendToCustomer).toHaveBeenCalledWith(
      expect.objectContaining({ templateId: 'pre_debit_reminder', toAddress: '0244000000' }),
    );
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

  it('labels a card by brand and last four, and copes without either', () => {
    expect(cardLabel({ brand: 'visa', last4: '4081' })).toBe('Visa card ending 4081');
    expect(cardLabel({ brand: null, last4: '4081' })).toBe('card ending 4081');
    expect(cardLabel({ brand: 'verve', last4: null })).toBe('saved Verve card');
    expect(cardLabel({ brand: null, last4: null })).toBe('saved card');
  });

  it('passes a custom limit through to the repository', async () => {
    const { runner, plans } = deps({ due: [] });
    await runner.sendUpcomingReminders('2026-06-20', { limit: 50 });
    expect(plans.listDueOn).toHaveBeenCalledWith('2026-06-20', 50);
  });
});
