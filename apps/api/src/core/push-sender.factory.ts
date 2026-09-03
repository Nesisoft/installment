import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { ExpoPushClient } from '@installment/push-client';
import type { PushSender } from '@installment/core';
import type { Env } from '../config/env.validation';
import { ConsolePushSender } from './console-push-sender';

/**
 * Chooses the push transport.
 *
 * The same shape as `createSmsSender`, and for the same reason: the provider
 * client satisfies the `PushSender` port structurally, so this is the only
 * place that has to know which one is in use.
 */
export function createPushSender(config: ConfigService<Env, true>): PushSender {
  const logger = new Logger('PushSender');
  const provider = config.get('PUSH_PROVIDER', { infer: true });

  switch (provider) {
    case 'expo':
      logger.log('Push provider: expo');
      return new ExpoPushClient({
        accessToken: config.get('EXPO_ACCESS_TOKEN', { infer: true }),
        baseUrl: config.get('EXPO_PUSH_BASE_URL', { infer: true }),
      });
    case 'console':
    default:
      // Not an error here — `validateEnv` already refuses to boot production on
      // this branch, so reaching it means a developer chose it deliberately.
      logger.warn('Push provider: console — notifications are logged, not delivered');
      return new ConsolePushSender();
  }
}
