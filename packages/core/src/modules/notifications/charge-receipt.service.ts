import { Money } from '../../shared/money/money';
import type { CustomerPlansService } from '../schedules/customer-plans.service';
import type { CustomersService } from '../customers/customers.service';
import type { NotificationService } from './notification.service';

/**
 * Customer-facing SMS receipts for charge outcomes. Looks up the plan +
 * customer + outstanding balance and renders the templated SMS via
 * NotificationService. Best-effort by design: every method swallows errors so
 * a notification failure can never break the charge that triggered it.
 *
 * PaymentService depends on a tiny port (notifyChargeSucceeded / Failed) — this
 * is one implementation. Tests can stub the port without faking SMS plumbing.
 */
export class ChargeReceiptService {
  constructor(
    private readonly plans: CustomerPlansService,
    private readonly customers: CustomersService,
    private readonly notifications: NotificationService,
  ) {}

  async notifyChargeSucceeded(scheduleId: string, amountPesewas: number): Promise<void> {
    try {
      const installment = await this.plans.getInstallment(scheduleId);
      const plan = await this.plans.get(installment.customer_plan_id);
      const customer = await this.customers.get(plan.customer_id);
      const to = recipientPhone(customer);
      if (!to) return; // nothing to send to
      await this.notifications.sendToCustomer({
        customerId: customer.id,
        toAddress: to,
        templateId: 'payment_succeeded',
        variables: {
          name: customer.first_name,
          amount: format(amountPesewas),
          outstanding: format(plan.outstanding_pesewas),
        },
      });
    } catch {
      // Receipts are best-effort; failures must never bubble.
    }
  }

  async notifyChargeFailed(scheduleId: string, amountPesewas: number): Promise<void> {
    try {
      const installment = await this.plans.getInstallment(scheduleId);
      const plan = await this.plans.get(installment.customer_plan_id);
      const customer = await this.customers.get(plan.customer_id);
      const to = recipientPhone(customer);
      if (!to) return;
      await this.notifications.sendToCustomer({
        customerId: customer.id,
        toAddress: to,
        templateId: 'payment_failed',
        variables: {
          name: customer.first_name,
          amount: format(amountPesewas),
        },
      });
    } catch {
      // best-effort
    }
  }
}

/**
 * The wallet number when there is one, else the account phone.
 *
 * Receipts went only to the MoMo number, so a customer who pays by card — the
 * auto-debit's first choice when a card is saved — got no receipt and no
 * notice that a debit failed, by SMS or by push. The texts name no
 * instrument, so either number reads correctly.
 */
function recipientPhone(customer: { momo_phone: string | null; phone: string }): string | null {
  return customer.momo_phone ?? customer.phone ?? null;
}

/** Pesewas → "1,234.56" (no currency prefix; templates already say "GHS"). */
function format(pesewas: number): string {
  return Money.fromPesewas(pesewas).format('').trim();
}
