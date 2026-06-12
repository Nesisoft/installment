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
      if (!customer.momo_phone) return; // nothing to send to
      await this.notifications.sendToCustomer({
        customerId: customer.id,
        toAddress: customer.momo_phone,
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
      if (!customer.momo_phone) return;
      await this.notifications.sendToCustomer({
        customerId: customer.id,
        toAddress: customer.momo_phone,
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

/** Pesewas → "1,234.56" (no currency prefix; templates already say "GHS"). */
function format(pesewas: number): string {
  return Money.fromPesewas(pesewas).format('').trim();
}
