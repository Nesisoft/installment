import { Money } from '../../shared/money/money';
import type { CustomerPlansService } from '../schedules/customer-plans.service';
import type { CustomersService } from '../customers/customers.service';
import type { AttemptRepository } from './attempt-repository';
import type { NotificationService } from '../notifications/notification.service';
import { ChargeAlreadyInFlightError } from './errors';

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

  /**
   * A payment link the customer asked for, rather than one we pushed at them
   * after auto-debit gave up.
   *
   * This is how a card gets on file at all. Nothing in the system could
   * previously produce a card payment: auto-debit only tried Mobile Money, and
   * the one card endpoint demanded an authorization code no client ever had. A
   * hosted Paystack page is also the only sane way to take card details —
   * entry, 3-D Secure and PCI scope all stay with Paystack, and the reusable
   * authorization comes back on the webhook.
   *
   * Idempotent by reuse: an outstanding link for this instalment is handed back
   * rather than replaced, so tapping twice does not scatter live links for the
   * same debt. An unresolved attempt that is NOT a link means a charge is
   * already moving, and stacking a link on top of it is how a customer pays
   * twice — so that refuses instead.
   */
  async createSelfServiceLink(scheduleId: string): Promise<{ url: string; reference: string }> {
    const installment = await this.plans.getInstallment(scheduleId);
    const plan = await this.plans.get(installment.customer_plan_id);
    const customer = await this.customers.get(plan.customer_id);

    const unresolved = await this.attempts.findUnresolvedForSchedule(scheduleId);
    if (unresolved?.payment_link_url) {
      return { url: unresolved.payment_link_url, reference: unresolved.provider_reference ?? '' };
    }
    if (unresolved) {
      throw new ChargeAlreadyInFlightError(
        scheduleId,
        `attempt ${unresolved.id} is ${unresolved.status}`,
      );
    }

    const amount = installment.amount_due_pesewas + installment.late_fee_pesewas;
    const reference = `LINK-${scheduleId}-self-${installment.attempt_count + 1}`;
    const res = await this.paystack.createPaymentLink({
      email: customer.email,
      amount,
      currency: 'GHS',
      reference,
      metadata: { schedule_id: scheduleId, kind: 'self_service_link' },
    });
    const url = res.data.authorization_url;

    // No state-machine transition: the customer pays out of band and the
    // webhook settles the schedule, exactly as for a pushed link.
    await this.attempts.create({
      scheduleId,
      customerPlanId: installment.customer_plan_id,
      channel: 'payment_link',
      paymentMethod: 'card',
      amountPesewas: amount,
      idempotencyKey: reference,
      providerReference: reference,
      paymentLinkUrl: url,
    });

    return { url, reference };
  }

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
