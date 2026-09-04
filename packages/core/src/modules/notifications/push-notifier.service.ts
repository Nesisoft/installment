import { eq } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import { DevicesService, type DeviceOwner } from './devices.service';

const notifications = schema.notifications;

/** The slice of a push provider the notifier needs (matches push-client's PushClient). */
export interface PushSender {
  send(message: {
    to: string;
    title: string;
    body: string;
    data?: Record<string, unknown>;
  }): Promise<{ id?: string; status: string; error?: string; rawResponse?: unknown }>;
}

/** Expo's word for "this handset no longer has the app". */
const DEVICE_NOT_REGISTERED = 'DeviceNotRegistered';

export interface PushInput {
  owner: DeviceOwner;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  /**
   * Recorded on the notification row. Free text rather than a
   * `NotificationTemplateId` because the SMS templates are rendered from
   * variables and these are composed by the caller — the row is a record of
   * what was sent, and pretending it came from a template it did not would
   * make the log worse, not tidier.
   */
  templateId: string;
}

export interface PushOutcome {
  /** Devices the provider accepted the message for. */
  sent: number;
  /** Devices it refused. */
  failed: number;
  /** Devices deactivated because the provider disowned the token. */
  deactivated: number;
  /** No handset registered, so nothing was attempted. */
  noDevices: boolean;
}

/**
 * The transport `push_devices` has been waiting for since 0015.
 *
 * That table shipped with a docstring saying so in as many words —
 * "NotificationService is still SMS-only, and adding a push transport is its
 * own slice" — and until now the slice did not exist: the customer app posted
 * tokens to `/me/devices`, `listActive` had no callers anywhere in the repo,
 * and `NotificationService` hardcoded `channel: 'sms'`. The
 * `notifications.channel` CHECK has permitted 'push' since 0000.
 *
 * Deliberately a sibling of `NotificationService` rather than a channel inside
 * it. The two differ in the shape of the thing being addressed, not just the
 * wire: an SMS goes to one number the caller already knows, while a push goes
 * to every handset an owner has registered and can come back saying one of
 * them no longer exists. Folding fan-out and token invalidation into a method
 * whose contract is "one recipient, one row" would make both harder to read.
 *
 * Never throws. A notification must not be able to break the flow that
 * triggered it — an order being placed, a payout going out — so a provider
 * that is down is recorded against every row and returned as a count.
 */
export class PushNotifier {
  constructor(
    private readonly db: Database,
    private readonly devices: DevicesService,
    private readonly push: PushSender,
  ) {}

  async send(input: PushInput): Promise<PushOutcome> {
    const handsets = await this.devices.listActive(input.owner);
    if (handsets.length === 0) {
      // Not an error, and not worth a `failed` row either: nobody has
      // installed the app yet. The caller's other channels still apply.
      return { sent: 0, failed: 0, deactivated: 0, noDevices: true };
    }

    const recipientType =
      'customerId' in input.owner && input.owner.customerId ? 'customer' : 'merchant';
    const recipientId =
      'customerId' in input.owner && input.owner.customerId
        ? input.owner.customerId
        : input.owner.merchantId!;

    const outcome: PushOutcome = { sent: 0, failed: 0, deactivated: 0, noDevices: false };

    for (const handset of handsets) {
      // One row per handset. Two phones is two deliveries and two things that
      // can independently fail, so collapsing them into one row would lose
      // which phone did not get it.
      const [row] = await this.db
        .insert(notifications)
        .values({
          recipient_type: recipientType,
          recipient_id: recipientId,
          channel: 'push',
          template_id: input.templateId,
          variables: { title: input.title, body: input.body, ...(input.data ?? {}) },
          to_address: handset.expo_token,
          status: 'queued',
        })
        .returning();
      if (!row) throw new Error('notifications insert returned no row');

      const nowIso = new Date().toISOString();
      try {
        const result = await this.push.send({
          to: handset.expo_token,
          title: input.title,
          body: input.body,
          data: input.data,
        });

        if (result.status === 'sent') {
          outcome.sent += 1;
          await this.db
            .update(notifications)
            .set({ status: 'sent', sent_at: nowIso, provider_message_id: result.id ?? null })
            .where(eq(notifications.id, row.id));
          continue;
        }

        outcome.failed += 1;
        await this.db
          .update(notifications)
          .set({
            status: 'failed',
            failed_at: nowIso,
            failure_reason: result.error ?? 'push_failed',
          })
          .where(eq(notifications.id, row.id));

        // The one failure that means something to the database rather than to
        // a log: the app is gone from that handset, so stop sending to it
        // instead of burning a request on it forever.
        if (result.error === DEVICE_NOT_REGISTERED) {
          await this.devices.deactivateToken(handset.expo_token);
          outcome.deactivated += 1;
        }
      } catch (err) {
        // A transport failure — the provider unreachable, a rate limit. The
        // token is fine, so the device stays active and the row records why.
        outcome.failed += 1;
        await this.db
          .update(notifications)
          .set({
            status: 'failed',
            failed_at: nowIso,
            failure_reason: err instanceof Error ? err.message : 'push_send_failed',
          })
          .where(eq(notifications.id, row.id));
      }
    }

    return outcome;
  }

  /** A merchant has an order waiting on them. */
  async notifyMerchantOfOrder(args: {
    merchantId: string;
    orderId: string;
    orderNumber: string;
    itemSummary: string;
    totalGhs: string;
  }): Promise<PushOutcome> {
    return this.send({
      owner: { merchantId: args.merchantId },
      templateId: 'merchant.order_placed',
      title: 'New order to confirm',
      body: `${args.itemSummary} · ${args.totalGhs}`,
      // What the app needs to deep-link straight to the order rather than
      // dropping the merchant on a dashboard to go and find it.
      data: { kind: 'order_placed', orderId: args.orderId, orderNumber: args.orderNumber },
    });
  }

  /**
   * A buyer's order has moved — shipped, out for delivery, delivered.
   *
   * Push-only on purpose. These are the events `order_events` has always
   * recorded and nothing has ever told anybody about: a customer who did not
   * open the app learned nothing. They are also not money notices, so paying
   * an SMS aggregator per order per step would be a real cost with nothing
   * riding on it — unlike the templates in `NotificationService`, which go by
   * SMS regardless and push as well.
   *
   * The title and body are the timeline event's own words, handed down by the
   * caller, so the tray and the order screen cannot disagree.
   */
  async notifyCustomerOfOrderEvent(args: {
    customerId: string;
    orderId: string;
    orderNumber: string;
    eventType: string;
    title: string;
    body: string;
  }): Promise<PushOutcome> {
    return this.send({
      owner: { customerId: args.customerId },
      templateId: args.eventType,
      title: args.title,
      body: args.body,
      data: { kind: args.eventType, orderId: args.orderId, orderNumber: args.orderNumber },
    });
  }
}
