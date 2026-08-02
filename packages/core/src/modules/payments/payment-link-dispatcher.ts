import { Money } from '../../shared/money/money';
import type { CustomerPlansService } from '../schedules/customer-plans.service';
import type { CustomersService } from '../customers/customers.service';
import type { AttemptRepository } from './attempt-repository';
import type { NotificationService } from '../notifications/notification.service';

/** The slice of the Paystack client the dispatcher needs (hosted checkout link). */
export interface PaymentLinkClient {
  createPaymentLink(req: {
    email: string;
    amount: number;
    currency: 'GHS';
    reference: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ data: { authorization_url: string; reference: string } }>;
}

export interface PaymentLinkOutcome {
  scheduleId: string;
  status: 'sent' | 'skipped' | 'failed';
  url?: string;
  reason?: string;
}

/**
 * The final retry fallback: when auto-debit has exhausted its attempts, we
 * create a hosted Paystack payment link and SMS it to the customer so they can
 * pay manually. The installment stays in `retry_scheduled`; the webhook settles
 * it when the customer pays. A durable `payment_attempts` row (channel
 * `payment_link`) records that the link was sent.
 */
export class PaymentLinkDispatcher {
  constructor(
    private readonly plans: CustomerPlansService,
    private readonly customers: CustomersService,
    private readonly attempts: AttemptRepository,
    private readonly notifications: NotificationService,
    private readonly paystack: PaymentLinkClient,
  ) {}

  async dispatch(scheduleId: string, attempt: number): Promise<PaymentLinkOutcome> {
    let email: string;
    let phone: string;
    let firstName: string;
    let customerId: string;
    let amount: number;
    let customerPlanId: string;
    try {
      const installment = await this.plans.getInstallment(scheduleId);
      const plan = await this.plans.get(installment.customer_plan_id);
      const customer = await this.customers.get(plan.customer_id);
      email = customer.email;
      phone = customer.momo_phone ?? '';
      firstName = customer.first_name;
      customerId = customer.id;
      customerPlanId = installment.customer_plan_id;
      amount = installment.amount_due_pesewas + installment.late_fee_pesewas;
    } catch (err) {
      return {
        scheduleId,
        status: 'skipped',
        reason: err instanceof Error ? err.message : 'lookup_failed',
      };
    }

    if (!phone) {
      return { scheduleId, status: 'skipped', reason: 'no_phone_on_file' };
    }

    const reference = `LINK-${scheduleId}-${attempt}`;
    let url: string;
    try {
      const res = await this.paystack.createPaymentLink({
        email,
        amount,
        currency: 'GHS',
        reference,
        metadata: { schedule_id: scheduleId, attempt, kind: 'payment_link' },
      });
      url = res.data.authorization_url;
    } catch (err) {
      return {
        scheduleId,
        status: 'failed',
        reason: err instanceof Error ? err.message : 'create_link_failed',
      };
    }

    // Durable record that a link was sent (no state-machine transition — the
    // customer pays out of band and the webhook settles the schedule).
    await this.attempts.create({
      scheduleId,
      customerPlanId,
      channel: 'payment_link',
      paymentMethod: 'momo',
      amountPesewas: amount,
      idempotencyKey: reference,
      providerReference: reference,
      // Persisted so support can re-send the exact link a customer was given,
      // and so a paid link is traceable back to the attempt that issued it.
      paymentLinkUrl: url,
    });

    const notification = await this.notifications.sendToCustomer({
      customerId,
      toAddress: phone,
      templateId: 'payment_link',
      variables: {
        name: firstName,
        amount: Money.fromPesewas(amount).format('').trim(),
        url,
      },
    });

    return {
      scheduleId,
      status: notification.status === 'sent' ? 'sent' : 'failed',
      url,
      reason: notification.status === 'failed' ? 'sms_failed' : undefined,
    };
  }
}
