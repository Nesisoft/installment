import { Money } from '../../shared/money/money';
import type { CustomerPlansService } from '../schedules/customer-plans.service';
import type { CustomersService } from '../customers/customers.service';
import type { NotificationService } from './notification.service';

export interface ReminderSweepSummary {
  forDate: string;
  candidates: number;
  sent: number;
  skipped: number;
}

/**
 * Pre-debit reminder sweep. Texts customers a heads-up the day before an
 * installment debits so their Mobile Money wallet is funded — the Ghanaian BNPL
 * expectation. Best-effort: a customer with no MoMo on file is skipped, and a
 * failed SMS is recorded by NotificationService (never thrown).
 */
export class ReminderRunner {
  constructor(
    private readonly plans: CustomerPlansService,
    private readonly customers: CustomersService,
    private readonly notifications: NotificationService,
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
      if (!customer.momo_phone || !customer.momo_provider) return false;

      const amount = installment.amount_due_pesewas + installment.late_fee_pesewas;
      const result = await this.notifications.sendToCustomer({
        customerId: customer.id,
        toAddress: customer.momo_phone,
        templateId: 'pre_debit_reminder',
        variables: {
          name: customer.first_name,
          amount: Money.fromPesewas(amount).format('').trim(),
          date: forDate,
          provider: customer.momo_provider,
          phone: customer.momo_phone,
        },
      });
      return result.status === 'sent';
    } catch {
      // Best-effort: a lookup/render failure for one installment never aborts the sweep.
      return false;
    }
  }
}
