import { eq } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import { renderNotification, type NotificationTemplateId } from './notification-templates';

const notifications = schema.notifications;

export type Notification = typeof schema.notifications.$inferSelect;
export type NotificationRecipientType = 'customer' | 'merchant' | 'admin';

/** The slice of an SMS provider the notifier needs (matches sms-client SmsClient). */
export interface NotificationSmsSender {
  send(message: {
    to: string;
    sender: string;
    message: string;
  }): Promise<{ id?: string } | unknown>;
}

export interface SendNotificationInput {
  recipientType: NotificationRecipientType;
  recipientId: string;
  templateId: NotificationTemplateId;
  variables: Record<string, string>;
  /** Phone in E.164 (or local) form. */
  toAddress: string;
}

export interface NotificationResult {
  notification: Notification;
  status: 'sent' | 'failed';
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
  ) {}

  async send(input: SendNotificationInput): Promise<NotificationResult> {
    const message = renderNotification(input.templateId, input.variables);

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
      })) as { id?: string };
      const [sent] = await this.db
        .update(notifications)
        .set({
          status: 'sent',
          sent_at: nowIso,
          provider_message_id: result?.id ?? null,
        })
        .where(eq(notifications.id, row.id))
        .returning();
      return { notification: sent!, status: 'sent' };
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
      return { notification: failed!, status: 'failed' };
    }
  }

  /** Convenience: send to a customer (the common case). */
  async sendToCustomer(args: {
    customerId: string;
    toAddress: string;
    templateId: NotificationTemplateId;
    variables: Record<string, string>;
  }): Promise<NotificationResult> {
    return this.send({
      recipientType: 'customer',
      recipientId: args.customerId,
      toAddress: args.toAddress,
      templateId: args.templateId,
      variables: args.variables,
    });
  }
}
