import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { ArkeselSmsClient, HubtelSmsClient } from '@installment/sms-client';
import type { SmsSender } from '@installment/core';
import type { Env } from '../config/env.validation';
import { ConsoleSmsSender } from './console-sms-sender';

/**
 * Chooses the SMS transport.
 *
 * `@installment/sms-client` shipped complete, with both providers tested, and
 * was a dependency of nothing — the API only ever had the console sender wired.
 * Customer auth is phone+OTP only, so on any real deployment that meant no
 * customer could log in, every reminder and dunning notice died in a log line,
 * and `notifications` recorded all of it as delivered.
 *
 * Both clients satisfy the `SmsSender` port structurally, so this is the only
 * place that needs to know which one is in use.
 */
export function createSmsSender(config: ConfigService<Env, true>): SmsSender {
  const logger = new Logger('SmsSender');
  const provider = config.get('SMS_PROVIDER', { infer: true });

  switch (provider) {
    case 'hubtel':
      logger.log('SMS provider: hubtel');
      return new HubtelSmsClient({
        clientId: config.get('HUBTEL_CLIENT_ID', { infer: true }),
        clientSecret: config.get('HUBTEL_CLIENT_SECRET', { infer: true }),
        baseUrl: config.get('HUBTEL_BASE_URL', { infer: true }),
        sendUrl: config.get('HUBTEL_SMS_URL', { infer: true }),
        senderId: config.get('HUBTEL_SENDER_ID', { infer: true }),
      });
    case 'arkesel':
      logger.log('SMS provider: arkesel');
      return new ArkeselSmsClient({
        apiKey: config.get('ARKESEL_API_KEY', { infer: true }),
        baseUrl: config.get('ARKESEL_BASE_URL', { infer: true }),
        senderId: config.get('ARKESEL_SENDER_ID', { infer: true }),
      });
    case 'console':
    default:
      // Not an error here — `validateEnv` already refuses to boot production on
      // this branch, so reaching it means a developer chose it deliberately.
      logger.warn('SMS provider: console — messages are logged, not delivered');
      return new ConsoleSmsSender(config.get('SMS_LOG_BODY', { infer: true }));
  }
}
