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
  }): Promise<{ id?: string; status?: string } | unknown>;
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
