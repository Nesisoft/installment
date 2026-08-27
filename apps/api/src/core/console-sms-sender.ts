import { Logger } from '@nestjs/common';
import type { SmsSender } from '@installment/core';

/**
 * Development SMS sender. Records that a message would have gone out and
 * delivers nothing.
 *
 * It used to log the full body at info level. That body carries the login OTP —
 * customer auth is phone+OTP only — so every log sink the service wrote to held
 * live credentials, with the phone number beside them saying whose. The
 * recipient is now masked and the body dropped unless a developer explicitly
 * asks for it, which is the one case where seeing an OTP in the terminal is the
 * point.
 *
 * `env.validation` refuses to boot production on this sender at all.
 */
export class ConsoleSmsSender implements SmsSender {
  private readonly logger = new Logger('SmsSender');

  constructor(private readonly logBody = false) {}

  send(message: { to: string; sender: string; message: string }): Promise<unknown> {
    this.logger.log(
      `[SMS simulated] to=${maskPhone(message.to)} from=${message.sender} ` +
        `chars=${message.message.length}` +
        (this.logBody ? ` :: ${message.message}` : ''),
    );
    // `queued`, not `sent`: nothing reached a carrier, and NotificationService
    // now records what it is told rather than assuming success.
    return Promise.resolve({ status: 'queued', simulated: true });
  }
}

/** `+233244123456` → `+233******456`. Enough to correlate, not enough to identify. */
export function maskPhone(phone: string): string {
  if (phone.length <= 7) return '*'.repeat(phone.length);
  return `${phone.slice(0, 4)}${'*'.repeat(phone.length - 7)}${phone.slice(-3)}`;
}
