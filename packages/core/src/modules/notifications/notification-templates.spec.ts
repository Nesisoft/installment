import { describe, expect, it } from 'vitest';
import {
  NOTIFICATION_TEMPLATES,
  NotificationTemplateError,
  renderNotification,
  renderPushNotification,
  type NotificationTemplateId,
} from './notification-templates';

describe('renderNotification', () => {
  it('renders the pre-debit reminder with the provider upper-cased', () => {
    const text = renderNotification('pre_debit_reminder', {
      name: 'Ama',
      amount: '250.00',
      date: '2026-06-20',
      provider: 'mtn',
      phone: '0244000000',
    });
    expect(text).toContain('Hi Ama');
    expect(text).toContain('GHS 250.00');
    expect(text).toContain('MTN wallet 0244000000');
    expect(text).toContain('- Installment');
  });

  it('renders the payment link with the URL', () => {
    const text = renderNotification('payment_link', {
      name: 'Kofi',
      amount: '1,000.00',
      url: 'https://paystack.shop/pay/xyz',
    });
    expect(text).toContain('GHS 1,000.00');
    expect(text).toContain('https://paystack.shop/pay/xyz');
  });

  it('renders the success and failure receipts', () => {
    expect(
      renderNotification('payment_succeeded', {
        name: 'Ama',
        amount: '250.00',
        outstanding: '750.00',
      }),
    ).toContain('Outstanding balance: GHS 750.00');
    expect(renderNotification('payment_failed', { name: 'Ama', amount: '250.00' })).toContain(
      "couldn't debit GHS 250.00",
    );
  });

  it('throws on a missing required variable rather than sending a half-rendered message', () => {
    expect(() => renderNotification('payment_link', { name: 'Kofi', amount: '10.00' })).toThrow(
      NotificationTemplateError,
    );
  });

  it('throws on an empty-string variable', () => {
    expect(() => renderNotification('payment_failed', { name: '', amount: '10.00' })).toThrow(
      /missing variable "name"/,
    );
  });

  it('renders the four collections dunning templates', () => {
    const vars = { name: 'Ama', amount: '750.00' };
    expect(renderNotification('collections_soft_reminder', vars)).toContain('overdue');
    expect(renderNotification('collections_firm_reminder', vars)).toContain('several days');
    expect(renderNotification('collections_restriction_warning', vars)).toContain('restricted');
    expect(renderNotification('collections_legal_threat', vars)).toContain('legal recovery');
  });
});

describe('push renderings', () => {
  const VARS: Record<NotificationTemplateId, Record<string, string>> = {
    pre_debit_reminder: {
      name: 'Ama',
      amount: '120.00',
      date: '12 Sep',
      provider: 'mtn',
      phone: '024 455 1338',
    },
    payment_link: { name: 'Ama', amount: '120.00', url: 'https://pay.example/abc' },
    payment_succeeded: { name: 'Ama', amount: '120.00', outstanding: '360.00' },
    payment_failed: { name: 'Ama', amount: '120.00' },
    collections_soft_reminder: { name: 'Ama', amount: '120.00' },
    collections_firm_reminder: { name: 'Ama', amount: '120.00' },
    collections_restriction_warning: { name: 'Ama', amount: '120.00' },
    collections_legal_threat: { name: 'Ama', amount: '120.00' },
  };

  it('gives every template a push rendering', () => {
    // Exhaustive rather than a sample: a template without one would reach the
    // tray as a bare SMS sentence, signed off "- Installment", which reads as a
    // broken app rather than a notification.
    for (const id of Object.keys(NOTIFICATION_TEMPLATES) as NotificationTemplateId[]) {
      const copy = renderPushNotification(id, VARS[id]);
      expect(copy.title.length, id).toBeGreaterThan(0);
      expect(copy.body.length, id).toBeGreaterThan(0);
      // A tray truncates. These are the lengths iOS and Android show without
      // expanding, and a title that needs expanding to be understood has
      // failed at the only job it has.
      expect(copy.title.length, id).toBeLessThanOrEqual(48);
      expect(copy.body.length, id).toBeLessThanOrEqual(120);
      // The SMS sign-off is for a channel where the sender is a shortcode.
      expect(copy.title, id).not.toContain('Installment');
      expect(copy.body, id).not.toContain(' - Installment');
      // "Hi Ama," is right for an SMS out of nowhere and wrong for a
      // notification from an app the customer installed.
      expect(copy.title, id).not.toMatch(/^Hi /);
    }
  });

  it('keeps the payment link out of the push body', () => {
    // A notification carrying a payment URL is the exact shape of a phishing
    // message, and teaching customers to tap one is a habit worth not starting.
    const copy = renderPushNotification('payment_link', VARS.payment_link);
    expect(copy.body).not.toContain('http');
    expect(copy.title).not.toContain('http');
  });

  it('refuses a missing variable on the push side too', () => {
    // Same validation as the SMS renderer, so a message cannot go out whole on
    // one channel and half-rendered on the other.
    expect(() => renderPushNotification('payment_succeeded', { name: 'Ama' })).toThrow(
      NotificationTemplateError,
    );
  });

  it('says the amount on every money notice', () => {
    for (const id of Object.keys(NOTIFICATION_TEMPLATES) as NotificationTemplateId[]) {
      const copy = renderPushNotification(id, VARS[id]);
      expect(`${copy.title} ${copy.body}`, id).toContain('120.00');
    }
  });
});
