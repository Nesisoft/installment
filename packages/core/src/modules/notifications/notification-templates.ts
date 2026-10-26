/**
 * Customer notification templates. Pure text rendering — money/dates are
 * formatted by the caller and passed in as strings, so this module has no domain
 * deps and is trivially testable. A missing required variable throws rather than
 * sending a half-rendered "{{name}}" to a customer.
 *
 * One definition per message, two renderings. SMS gets the self-contained
 * sentence it has always got, because it may be the only thing the recipient
 * ever sees. Push gets a title and a shorter body, because a notification tray
 * truncates and the app is one tap away for the rest.
 *
 * Push never replaces SMS here. Every message in this file is one that costs the
 * customer money if it does not arrive — a missed debit is a late fee — and a
 * push reaches a handset that has the app, has data, and has granted
 * permission. So the push is an addition: faster and deep-linkable when it
 * lands, and nothing is lost when it does not. Informational messages that are
 * *not* money-critical (an order shipping, say) are push-only, and live with the
 * service that raises them rather than here.
 *
 * One is for a seller rather than a customer — `payout_account_changed` — and
 * is here for the same reason: missing it costs them their settlements.
 * NotificationService pushes only to customers, so its push copy is unused.
 */
export type NotificationTemplateId =
  | 'pre_debit_reminder'
  | 'pre_debit_reminder_card'
  | 'pre_debit_reminder_manual'
  | 'payment_link'
  | 'payment_succeeded'
  | 'payment_failed'
  | 'collections_soft_reminder'
  | 'collections_firm_reminder'
  | 'collections_restriction_warning'
  | 'collections_legal_threat'
  | 'payout_account_changed';

/** A push notification's two halves, as a tray renders them. */
export interface PushCopy {
  title: string;
  body: string;
}

interface TemplateDef {
  /** Variables the template requires; render throws if any is missing/empty. */
  required: readonly string[];
  render: (v: Record<string, string>) => string;
  /**
   * The same message as a push. Required for every template here — these are
   * all customer money notices, and one that reached the tray as a bare SMS
   * sentence would read as a broken app.
   */
  push: (v: Record<string, string>) => PushCopy;
}

const SIGNOFF = 'Installment';

export const NOTIFICATION_TEMPLATES: Record<NotificationTemplateId, TemplateDef> = {
  pre_debit_reminder: {
    required: ['name', 'amount', 'date', 'provider', 'phone'],
    render: (v) =>
      `Hi ${v.name}, GHS ${v.amount} for your installment is due ${v.date}. ` +
      `Please keep your ${String(v.provider).toUpperCase()} wallet ${v.phone} funded so the debit goes through. - ${SIGNOFF}`,
    push: (v) => ({
      title: `GHS ${v.amount} due ${v.date}`,
      body: `Keep your ${String(v.provider).toUpperCase()} wallet funded so the debit goes through.`,
    }),
  },
  // The same heads-up for a customer the auto-debit will charge by card — it
  // tries a saved card first. A card-only customer was sent nothing (the
  // reminder needed a Mobile Money number to go to), and one with both was told
  // to fund a wallet the debit was not going to touch.
  pre_debit_reminder_card: {
    required: ['name', 'amount', 'date', 'card'],
    render: (v) =>
      `Hi ${v.name}, GHS ${v.amount} for your installment is due ${v.date}. ` +
      `We will charge your ${v.card}. - ${SIGNOFF}`,
    push: (v) => ({
      title: `GHS ${v.amount} due ${v.date}`,
      body: `We will charge your ${v.card}.`,
    }),
  },
  // And for one with nothing on file to collect from: the debit cannot happen,
  // so the reminder is the only thing that can stop the instalment going late.
  pre_debit_reminder_manual: {
    required: ['name', 'amount', 'date'],
    render: (v) =>
      `Hi ${v.name}, GHS ${v.amount} for your installment is due ${v.date}. ` +
      `There is nothing on file to collect it from, so please pay it in the app. - ${SIGNOFF}`,
    push: (v) => ({
      title: `GHS ${v.amount} due ${v.date}`,
      body: 'Nothing is on file to collect it from. Open the app to pay it.',
    }),
  },
  payment_link: {
    required: ['name', 'amount', 'url'],
    render: (v) =>
      `Hi ${v.name}, your GHS ${v.amount} installment is due. Pay securely here: ${v.url} - ${SIGNOFF}`,
    // No URL in the push body: the app opens its own payment screen, and a
    // notification carrying a payment link is the exact shape of a phishing
    // message we would rather customers never learn to trust.
    push: (v) => ({
      title: `GHS ${v.amount} installment due`,
      body: 'Tap to pay now.',
    }),
  },
  payment_succeeded: {
    required: ['name', 'amount', 'outstanding'],
    render: (v) =>
      `Hi ${v.name}, we received your GHS ${v.amount} payment. ` +
      `Outstanding balance: GHS ${v.outstanding}. Thank you! - ${SIGNOFF}`,
    push: (v) => ({
      title: `GHS ${v.amount} received`,
      body: `Outstanding balance: GHS ${v.outstanding}. Thank you!`,
    }),
  },
  payment_failed: {
    required: ['name', 'amount'],
    render: (v) =>
      `Hi ${v.name}, we couldn't debit GHS ${v.amount} for your installment. ` +
      `We'll try again shortly, or you can pay via the link we send. - ${SIGNOFF}`,
    push: (v) => ({
      title: `GHS ${v.amount} debit did not go through`,
      body: "We'll try again shortly, or you can pay now.",
    }),
  },
  collections_soft_reminder: {
    required: ['name', 'amount'],
    render: (v) =>
      `Hi ${v.name}, your installment of GHS ${v.amount} is overdue. ` +
      `Please pay today to avoid further action. - ${SIGNOFF}`,
    push: (v) => ({
      title: `GHS ${v.amount} is overdue`,
      body: 'Please pay today to avoid further action.',
    }),
  },
  collections_firm_reminder: {
    required: ['name', 'amount'],
    render: (v) =>
      `Hi ${v.name}, your GHS ${v.amount} installment is now several days overdue. ` +
      `Pay promptly to keep your account in good standing. - ${SIGNOFF}`,
    push: (v) => ({
      title: `GHS ${v.amount} is several days overdue`,
      body: 'Pay promptly to keep your account in good standing.',
    }),
  },
  collections_restriction_warning: {
    required: ['name', 'amount'],
    render: (v) =>
      `Hi ${v.name}, your account will be restricted from new purchases unless ` +
      `GHS ${v.amount} is paid. Please act today. - ${SIGNOFF}`,
    push: (v) => ({
      title: 'Your account is about to be restricted',
      body: `GHS ${v.amount} is unpaid. Please act today.`,
    }),
  },
  collections_legal_threat: {
    required: ['name', 'amount'],
    render: (v) =>
      `Hi ${v.name}, GHS ${v.amount} remains unpaid. We will refer your account for ` +
      `legal recovery unless paid within 7 days. - ${SIGNOFF}`,
    push: (v) => ({
      title: 'Final notice before legal recovery',
      body: `GHS ${v.amount} remains unpaid. You have 7 days.`,
    }),
  },
  // To a seller, at the phone on file, when their payout account is replaced.
  // The code that authorised it went to the same phone, but a code can be
  // talked out of someone; this says what happened, where the money will go,
  // and that nothing moves for a day — the window to stop it.
  payout_account_changed: {
    required: ['destination', 'account', 'name', 'until'],
    render: (v) =>
      `Your payouts will now go to ${v.destination} ${v.account} (${v.name}). ` +
      `Nothing is paid there before ${v.until}. If you did not make this change, contact support now. - ${SIGNOFF}`,
    push: (v) => ({
      title: 'Payout account changed',
      body: `Payouts now go to ${v.destination} ${v.account}. Not you? Contact support now.`,
    }),
  },
};

function assertRenderable(
  templateId: NotificationTemplateId,
  variables: Record<string, string>,
): TemplateDef {
  const def = NOTIFICATION_TEMPLATES[templateId];
  if (!def) throw new NotificationTemplateError(templateId, 'unknown template');
  for (const key of def.required) {
    const value = variables[key];
    if (value === undefined || value === null || value === '') {
      throw new NotificationTemplateError(templateId, `missing variable "${key}"`);
    }
  }
  return def;
}

export class NotificationTemplateError extends Error {
  constructor(templateId: string, message: string) {
    super(`Template "${templateId}": ${message}`);
    this.name = 'NotificationTemplateError';
  }
}

/** Renders a template to SMS text. Throws on an unknown template or missing variable. */
export function renderNotification(
  templateId: NotificationTemplateId,
  variables: Record<string, string>,
): string {
  const def = assertRenderable(templateId, variables);
  return def.render(variables);
}

/**
 * Renders a template as a push title and body. Same required variables and the
 * same refusal on a missing one, so a message cannot go out half-rendered on
 * one channel and whole on the other.
 */
export function renderPushNotification(
  templateId: NotificationTemplateId,
  variables: Record<string, string>,
): PushCopy {
  const def = assertRenderable(templateId, variables);
  return def.push(variables);
}
