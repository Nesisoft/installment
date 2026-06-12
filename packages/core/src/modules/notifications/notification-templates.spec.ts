import { describe, expect, it } from 'vitest';
import { NotificationTemplateError, renderNotification } from './notification-templates';

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
