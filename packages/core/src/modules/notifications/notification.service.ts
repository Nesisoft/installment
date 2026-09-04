import { eq } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import {
  renderNotification,
  renderPushNotification,
  type NotificationTemplateId,
} from './notification-templates';

const notifications = schema.notifications;

export type Notification = typeof schema.notifications.$inferSelect;
export type NotificationRecipientType = 'customer' | 'merchant' | 'admin';

/** The slice of an SMS provider the notifier needs (matches sms-client SmsClient). */
export interface NotificationSmsSender {
  send(message: {
    to: string;
    sender: string;
    message: string;
  }): Promise<{ id?: string; status?: string } | unknown>;
}

/**
 * The slice of {@link PushNotifier} this service needs.
 *
 * A narrow port rather than the class, for the reason every other port here is
 * one: core states what it requires, the real notifier satisfies it
 * structurally, and the fixtures that construct a NotificationService do not
 * all have to grow a push transport.
 */
export interface NotificationPushSender {
  send(input: {
    owner: { customerId: string };
    title: string;
    body: string;
    data?: Record<string, unknown>;
    templateId: string;
  }): Promise<unknown>;
}

export interface SendNotificationInput {
  recipientType: NotificationRecipientType;
  recipientId: string;
  templateId: NotificationTemplateId;
  variables: Record<string, string>;
  /** Phone in E.164 (or local) form. */
  toAddress: string;
  /**
   * Extra keys for the push payload, so the app can open the screen the message
   * is about instead of its home tab. The template id is always included.
   */
  pushData?: Record<string, unknown>;
}

export interface NotificationResult {
  notification: Notification;
  /**
   * `queued` means the provider accepted it but has not reported delivery —
   * which is the honest answer for most Ghanaian aggregators, and the only
   * answer the console sender can give.
   */
  status: 'queued' | 'sent' | 'failed';
}

/**
 * What the provider told us, mapped onto `notifications.status`.
 *
 * The service used to write `sent` whenever the call resolved, so the table
 * asserted delivery for every message — including the console sender's, which
 * delivers nothing. A row claiming `sent` for a message that never left the
 * process is worse than no row: it is the record you would reach for to prove
 * a dunning notice was served.
 */
function reportedStatus(result: unknown): 'queued' | 'sent' {
  const status = (result as { status?: unknown } | undefined)?.status;
  return status === 'sent' ? 'sent' : 'queued';
}

/**
 * Queues, sends, and records customer/merchant SMS notifications. Every send
 * writes a durable `notifications` row first (queued), then flips it to
 * `sent`/`failed` after the provider call — so a dropped SMS is auditable, not
 * silent. Never throws: a provider failure is recorded and returned, so a
 * notification can never break the flow that triggered it (a debit, a payout).
 */
export class NotificationService {
  constructor(
    private readonly db: Database,
    private readonly sms: NotificationSmsSender,
    private readonly senderId = 'Installmt',
    /**
     * Pushes the same message to the customer's handsets, alongside the SMS.
     *
     * Optional, and additive by design: every template here is one that costs
     * the customer money if it does not arrive, and a push needs the app
     * installed, data, and permission. So the SMS goes regardless and the push
     * is the fast, tappable copy for whoever has the app. Unwired, this
     * behaves exactly as it did before.
     */
    private readonly push?: NotificationPushSender,
  ) {}

  async send(input: SendNotificationInput): Promise<NotificationResult> {
    const message = renderNotification(input.templateId, input.variables);
    // Before the SMS, so a template with a missing variable fails the whole
    // send rather than going out on one channel and not the other.
    const pushCopy =
      this.push && input.recipientType === 'customer'
        ? renderPushNotification(input.templateId, input.variables)
        : null;

    const [row] = await this.db
      .insert(notifications)
      .values({
        recipient_type: input.recipientType,
        recipient_id: input.recipientId,
        channel: 'sms',
        template_id: input.templateId,
        variables: input.variables,
        to_address: input.toAddress,
        status: 'queued',
      })
      .returning();
    if (!row) throw new Error('notifications insert returned no row');

    const nowIso = new Date().toISOString();
    try {
      const result = (await this.sms.send({
        to: input.toAddress,
        sender: this.senderId,
        message,
      })) as { id?: string; status?: string };
      const status = reportedStatus(result);
      const [sent] = await this.db
        .update(notifications)
        .set({
          status,
          // Only stamp a send time for something the provider says it sent.
          ...(status === 'sent' ? { sent_at: nowIso } : {}),
          provider_message_id: result?.id ?? null,
        })
        .where(eq(notifications.id, row.id))
        .returning();
      await this.pushAlongside(input, pushCopy);
      return { notification: sent!, status };
    } catch (err) {
      const [failed] = await this.db
        .update(notifications)
        .set({
          status: 'failed',
          failed_at: nowIso,
          failure_reason: err instanceof Error ? err.message : 'sms_send_failed',
        })
        .where(eq(notifications.id, row.id))
        .returning();
      // The SMS did not go out, which is exactly when the other channel earns
      // its keep. Still additive, still not a replacement — but not skipped
      // just because the first attempt failed.
      await this.pushAlongside(input, pushCopy);
      return { notification: failed!, status: 'failed' };
    }
  }

  /**
   * Pushes the same message, and swallows everything.
   *
   * `PushNotifier` already records a row per handset and reports failures as
   * counts rather than throwing, so there is normally nothing to catch. The
   * try/catch is for the case it cannot reach the database at all: a
   * notification must not be able to break the flow that raised it, and the
   * SMS row for this message is already written either way.
   */
  private async pushAlongside(
    input: SendNotificationInput,
    copy: { title: string; body: string } | null,
  ): Promise<void> {
    if (!copy || !this.push) return;
    try {
      await this.push.send({
        owner: { customerId: input.recipientId },
        title: copy.title,
        body: copy.body,
        data: { kind: input.templateId, ...(input.pushData ?? {}) },
        templateId: input.templateId,
      });
    } catch {
      // Recorded by the notifier where it could be; nothing useful to do here.
    }
  }

  /** Convenience: send to a customer (the common case). */
  async sendToCustomer(args: {
    customerId: string;
    toAddress: string;
    templateId: NotificationTemplateId;
    variables: Record<string, string>;
    pushData?: Record<string, unknown>;
  }): Promise<NotificationResult> {
    return this.send({
      recipientType: 'customer',
      recipientId: args.customerId,
      toAddress: args.toAddress,
      templateId: args.templateId,
      variables: args.variables,
      pushData: args.pushData,
    });
  }
}
