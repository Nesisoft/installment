import { Money } from '../../shared/money/money';
import type { CustomerPlansService } from '../schedules/customer-plans.service';
import type { CustomersService } from '../customers/customers.service';
import type { CardAuthorizationService } from '../payments/card-authorization.service';
import type { NotificationService } from './notification.service';

export interface ReminderSweepSummary {
  forDate: string;
  candidates: number;
  sent: number;
  skipped: number;
}

/**
 * Pre-debit reminder sweep. Texts customers a heads-up the day before an
 * installment debits, naming what the debit will charge — the Ghanaian BNPL
 * expectation. Best-effort: a failed SMS is recorded by NotificationService
 * (never thrown).
 *
 * It follows DebitRunner's choice of instrument. A saved card is charged first,
 * so a customer with one is told about the card, at their account phone; one
 * with only Mobile Money is told to fund that wallet, at the wallet's number;
 * and one with neither is told to pay in the app, because nothing will collect
 * it for them. Nor will anything collect it on a plan whose automatic
 * collection the customer switched off — `listDueForAutoDebit` skips those
 * plans — so they are told to pay in the app too, whatever is on file. The sweep used to text only customers with a MoMo number, so a
 * card-only customer heard nothing until the charge, and one with nothing on
 * file heard nothing until the late fee.
 */
export class ReminderRunner {
  constructor(
    private readonly plans: CustomerPlansService,
    private readonly customers: CustomersService,
    private readonly notifications: NotificationService,
    /** Optional so framework-free callers keep working; without it no card is assumed. */
    private readonly cards?: Pick<CardAuthorizationService, 'findUsable'>,
  ) {}

  /**
   * Sends the pre-debit reminder for every installment due on `forDate`
   * (YYYY-MM-DD). Run daily for tomorrow's date.
   */
  async sendUpcomingReminders(
    forDate: string,
    opts: { limit?: number } = {},
  ): Promise<ReminderSweepSummary> {
    const due = await this.plans.listDueOn(forDate, opts.limit);
    const summary: ReminderSweepSummary = {
      forDate,
      candidates: due.length,
      sent: 0,
      skipped: 0,
    };

    for (const installment of due) {
      const sent = await this.remindOne(installment, forDate);
      if (sent) summary.sent += 1;
      else summary.skipped += 1;
    }
    return summary;
  }

  private async remindOne(
    installment: {
      id: string;
      customer_plan_id: string;
      amount_due_pesewas: number;
      late_fee_pesewas: number;
    },
    forDate: string,
  ): Promise<boolean> {
    try {
      const plan = await this.plans.get(installment.customer_plan_id);
      const customer = await this.customers.get(plan.customer_id);
      const autopay = plan.autopay_enabled !== false;
      // Usable on the day it will be charged, not the day this runs: a card
      // expiring at the end of this month is gone by a debit on the 1st.
      const card =
        autopay && this.cards
          ? await this.cards.findUsable(customer.id, debitDay(forDate)).catch(() => null)
          : null;

      const base = {
        name: customer.first_name,
        amount: Money.fromPesewas(installment.amount_due_pesewas + installment.late_fee_pesewas)
          .format('')
          .trim(),
        date: forDate,
      };
      const message = card
        ? {
            toAddress: customer.phone,
            templateId: 'pre_debit_reminder_card' as const,
            variables: { ...base, card: cardLabel(card) },
          }
        : autopay && customer.momo_phone && customer.momo_provider
          ? {
              toAddress: customer.momo_phone,
              templateId: 'pre_debit_reminder' as const,
              variables: {
                ...base,
                provider: customer.momo_provider,
                phone: customer.momo_phone,
              },
            }
          : {
              toAddress: customer.phone,
              templateId: 'pre_debit_reminder_manual' as const,
              variables: base,
            };
      if (!message.toAddress) return false;

      const result = await this.notifications.sendToCustomer({
        customerId: customer.id,
        ...message,
      });
      return result.status === 'sent';
    } catch {
      // Best-effort: a lookup/render failure for one installment never aborts the sweep.
      return false;
    }
  }
}

/** Noon UTC on the due date — inside that day wherever the card's month is read. */
function debitDay(forDate: string): Date {
  return new Date(`${forDate}T12:00:00Z`);
}

/** "Visa card ending 4081" — enough for a person to know which card is meant. */
export function cardLabel(card: { brand: string | null; last4: string | null }): string {
  const brand = card.brand?.trim();
  const named = brand
    ? `${brand.charAt(0).toUpperCase()}${brand.slice(1).toLowerCase()} card`
    : 'card';
  return card.last4 ? `${named} ending ${card.last4}` : `saved ${named}`;
}
