/**
 * SMS notification templates. Pure text rendering — money/dates are formatted
 * by the caller and passed in as strings, so this module has no domain deps and
 * is trivially testable. A missing required variable throws rather than sending
 * a half-rendered "{{name}}" to a customer.
 */
export type NotificationTemplateId =
  | 'pre_debit_reminder'
  | 'payment_link'
  | 'payment_succeeded'
  | 'payment_failed'
  | 'collections_soft_reminder'
  | 'collections_firm_reminder'
  | 'collections_restriction_warning'
  | 'collections_legal_threat';

interface TemplateDef {
  /** Variables the template requires; render throws if any is missing/empty. */
  required: readonly string[];
  render: (v: Record<string, string>) => string;
}

const SIGNOFF = 'Installment';

export const NOTIFICATION_TEMPLATES: Record<NotificationTemplateId, TemplateDef> = {
  pre_debit_reminder: {
    required: ['name', 'amount', 'date', 'provider', 'phone'],
    render: (v) =>
      `Hi ${v.name}, GHS ${v.amount} for your installment is due ${v.date}. ` +
      `Please keep your ${String(v.provider).toUpperCase()} wallet ${v.phone} funded so the debit goes through. - ${SIGNOFF}`,
  },
  payment_link: {
    required: ['name', 'amount', 'url'],
    render: (v) =>
      `Hi ${v.name}, your GHS ${v.amount} installment is due. Pay securely here: ${v.url} - ${SIGNOFF}`,
  },
  payment_succeeded: {
    required: ['name', 'amount', 'outstanding'],
    render: (v) =>
      `Hi ${v.name}, we received your GHS ${v.amount} payment. ` +
      `Outstanding balance: GHS ${v.outstanding}. Thank you! - ${SIGNOFF}`,
  },
  payment_failed: {
    required: ['name', 'amount'],
    render: (v) =>
      `Hi ${v.name}, we couldn't debit GHS ${v.amount} for your installment. ` +
      `We'll try again shortly, or you can pay via the link we send. - ${SIGNOFF}`,
  },
  collections_soft_reminder: {
    required: ['name', 'amount'],
    render: (v) =>
      `Hi ${v.name}, your installment of GHS ${v.amount} is overdue. ` +
      `Please pay today to avoid further action. - ${SIGNOFF}`,
  },
  collections_firm_reminder: {
    required: ['name', 'amount'],
    render: (v) =>
      `Hi ${v.name}, your GHS ${v.amount} installment is now several days overdue. ` +
      `Pay promptly to keep your account in good standing. - ${SIGNOFF}`,
  },
  collections_restriction_warning: {
    required: ['name', 'amount'],
    render: (v) =>
      `Hi ${v.name}, your account will be restricted from new purchases unless ` +
      `GHS ${v.amount} is paid. Please act today. - ${SIGNOFF}`,
  },
  collections_legal_threat: {
    required: ['name', 'amount'],
    render: (v) =>
      `Hi ${v.name}, GHS ${v.amount} remains unpaid. We will refer your account for ` +
      `legal recovery unless paid within 7 days. - ${SIGNOFF}`,
  },
};

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
  const def = NOTIFICATION_TEMPLATES[templateId];
  if (!def) throw new NotificationTemplateError(templateId, 'unknown template');
  for (const key of def.required) {
    const value = variables[key];
    if (value === undefined || value === null || value === '') {
      throw new NotificationTemplateError(templateId, `missing variable "${key}"`);
    }
  }
  return def.render(variables);
}
