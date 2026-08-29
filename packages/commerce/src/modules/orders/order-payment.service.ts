import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import type { PlanActor } from '@installment/core';
import { OrdersService, type OrderWithItems } from './orders.service';
import { OrderNotPayableError } from './errors';

const o = schema.orders;

/** The slice of the payment provider this service needs. */
export interface OrderChargeClient {
  chargeMobileMoney(req: {
    email: string;
    amount: number;
    currency: 'GHS';
    phone: string;
    provider: 'mtn' | 'tgo' | 'vod';
    reference: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ data: { reference: string; status: string; display_text?: string } }>;

  createPaymentLink(req: {
    email: string;
    amount: number;
    currency: 'GHS';
    reference: string;
    callback_url?: string;
    channels?: ('card' | 'mobile_money' | 'bank' | 'ussd' | 'bank_transfer' | 'qr')[];
    metadata?: Record<string, unknown>;
  }): Promise<{ data: { reference: string; access_code: string; authorization_url: string } }>;
}

export interface PayOrderInput {
  orderId: string;
  customerId: string;
  email: string;
  phone: string;
  provider: 'mtn' | 'tgo' | 'vod';
}

export interface PayOrderByCardInput {
  orderId: string;
  customerId: string;
  email: string;
  /** Where Paystack sends the browser once the customer is done. */
  callbackUrl?: string;
}

export interface CardCheckoutSession {
  reference: string;
  /** The hosted page to open. The card never touches our servers. */
  authorization_url: string;
  access_code: string;
}

export type OrderChargeStatus = 'paid' | 'pending' | 'failed';

export interface OrderChargeResult {
  status: OrderChargeStatus;
  reference: string;
  /** Present once the charge has actually settled the order. */
  order?: OrderWithItems;
  /** What the provider said, for a failure the customer should see. */
  message?: string;
}

/**
 * Lets a customer pay for a pay-in-full order themselves.
 *
 * Until now the only way an order got paid was an operator reconciling the money
 * by hand. This is the customer-facing half.
 *
 * It deliberately does NOT reuse `payment_attempts`: that table is shaped for
 * installment schedules, and seven modules read it assuming one — including the
 * credit-scoring behaviour collector, where an order payment would pollute a
 * customer's credit signals with ordinary shopping. Instead the provider
 * reference lives on the order (0012), which is all the webhook needs to resolve
 * a `charge.success` back to it.
 *
 * The reference is derived from the order id and therefore stable across
 * retries. That is the point: a customer who taps Pay again after a timeout
 * sends the provider the same reference, so the provider treats it as the same
 * transaction rather than a second debit.
 */
export class OrderPaymentService {
  constructor(
    private readonly db: Database,
    private readonly orders: OrdersService,
    private readonly paystack: OrderChargeClient,
  ) {}

  /** `ORD-<order id without dashes>` — stable per order, and charset-safe. */
  static referenceFor(orderId: string): string {
    return `ORD-${orderId.replace(/-/g, '')}`;
  }

  async payWithMobileMoney(input: PayOrderInput, actor: PlanActor): Promise<OrderChargeResult> {
    const order = await this.orders.get(input.customerId, input.orderId);
    if (order.payment_type !== 'full' || order.status !== 'pending_payment') {
      throw new OrderNotPayableError(input.orderId, order.status);
    }

    const reference = OrderPaymentService.referenceFor(order.id);
    // Recorded before the provider is called, never after: if the process dies
    // mid-charge, the webhook still has something to resolve the money against.
    await this.db.update(o).set({ payment_reference: reference }).where(eq(o.id, order.id));

    const response = await this.paystack.chargeMobileMoney({
      email: input.email,
      amount: order.total_pesewas,
      currency: 'GHS',
      phone: input.phone,
      provider: input.provider,
      reference,
      metadata: { order_id: order.id, order_number: order.order_number },
    });

    const status = response.data.status;
    if (status === 'success') {
      const paid = await this.orders.confirmPayment(
        order.id,
        { provider_reference: reference },
        actor,
      );
      return { status: 'paid', reference, order: paid };
    }
    if (status === 'pay_offline' || status === 'pending' || status === 'send_otp') {
      // The customer still has to approve it on their handset. The webhook
      // settles the order when they do.
      return { status: 'pending', reference, message: response.data.display_text };
    }
    return { status: 'failed', reference, message: response.data.display_text ?? status };
  }

  /**
   * Opens a hosted card checkout for a pay-in-full order.
   *
   * Cards are not charged the way Mobile Money is. A MoMo charge is a push to a
   * handset the customer already holds, so it can be initiated server-side from
   * a phone number. A card needs the PAN, the CVV and — in Ghana, for 3-D Secure
   * — an issuer's own challenge page. Handling any of that ourselves would put
   * cardholder data through our servers and pull the whole system into PCI DSS
   * scope for no benefit. So this returns Paystack's hosted page and the
   * customer completes the payment there.
   *
   * Settlement needs nothing new. The reference is the same stable
   * `ORD-<order id>` the MoMo path uses, so the existing `charge.success`
   * webhook resolves it through `settleByPaymentReference` exactly as before —
   * which also means a customer who abandons the page simply leaves the order
   * unpaid, to be swept by the same TTL cron.
   *
   * Restricted to the card channel deliberately: offering Mobile Money here too
   * would present a worse version of a journey the app already does natively,
   * and split one payment method across two paths.
   */
  async payWithCard(input: PayOrderByCardInput, _actor: PlanActor): Promise<CardCheckoutSession> {
    const order = await this.orders.get(input.customerId, input.orderId);
    if (order.payment_type !== 'full' || order.status !== 'pending_payment') {
      throw new OrderNotPayableError(input.orderId, order.status);
    }

    const reference = OrderPaymentService.referenceFor(order.id);
    // Same ordering as the MoMo path, for the same reason: if this process dies
    // after the customer pays, the webhook still has something to resolve
    // the money against.
    await this.db.update(o).set({ payment_reference: reference }).where(eq(o.id, order.id));

    const response = await this.paystack.createPaymentLink({
      email: input.email,
      amount: order.total_pesewas,
      currency: 'GHS',
      reference,
      callback_url: input.callbackUrl,
      channels: ['card'],
      metadata: { order_id: order.id, order_number: order.order_number },
    });

    return {
      reference,
      authorization_url: response.data.authorization_url,
      access_code: response.data.access_code,
    };
  }

  /**
   * Settles the order a provider reference belongs to. This is what the webhook
   * calls when a `charge.success` matches no installment payment attempt.
   *
   * Returns false when the reference is not an order's, so the caller can keep
   * treating a genuinely unknown reference as the alert-worthy event it is.
   */
  async settleByPaymentReference(reference: string, actor: PlanActor): Promise<boolean> {
    const [row] = await this.db
      .select({ id: o.id, status: o.status })
      .from(o)
      .where(and(eq(o.payment_reference, reference)))
      .limit(1);
    if (!row) return false;

    // Already settled — the webhook retried, or it raced the synchronous
    // response. Claim it so the caller does not alert on a reference we know.
    if (row.status !== 'pending_payment') return true;

    await this.orders.confirmPayment(row.id, { provider_reference: reference }, actor);
    return true;
  }

  /** The order a provider reference belongs to, if any. */
  async findByPaymentReference(reference: string): Promise<{ id: string } | null> {
    const [row] = await this.db
      .select({ id: o.id })
      .from(o)
      .where(eq(o.payment_reference, reference))
      .limit(1);
    return row ?? null;
  }
}
