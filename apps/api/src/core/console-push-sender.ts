import { Logger } from '@nestjs/common';
import type { PushSender } from '@installment/core';

/**
 * Development push sender. Records that a notification would have gone out and
 * delivers nothing.
 *
 * The token is masked for the same reason the console SMS sender masks a phone
 * number: an Expo push token is a bearer capability — anyone holding it can
 * send that handset a notification — so a log sink full of them is a log sink
 * full of credentials.
 *
 * `env.validation` refuses to boot production on this sender at all.
 */
export class ConsolePushSender implements PushSender {
  private readonly logger = new Logger('PushSender');

  send(message: {
    to: string;
    title: string;
    body: string;
    data?: Record<string, unknown>;
  }): Promise<{ id?: string; status: string; error?: string; rawResponse?: unknown }> {
    this.logger.log(
      `[push simulated] to=${maskToken(message.to)} title=${JSON.stringify(message.title)} ` +
        `body=${JSON.stringify(message.body)}` +
        (message.data ? ` data=${JSON.stringify(message.data)}` : ''),
    );
    // 'sent' rather than 'queued', unlike the SMS console sender: there is no
    // carrier hand-off to be honest about, and a developer watching the log
    // needs the success path to be the one that runs.
    return Promise.resolve({ status: 'sent', rawResponse: { simulated: true } });
  }
}

/** `ExponentPushToken[abcdef123456]` → `ExponentPushToken[ab********56]`. */
export function maskToken(token: string): string {
  const inner = /\[(.*)\]$/.exec(token)?.[1];
  if (!inner) return '*'.repeat(token.length);
  const masked =
    inner.length <= 4
      ? '*'.repeat(inner.length)
      : `${inner.slice(0, 2)}${'*'.repeat(inner.length - 4)}${inner.slice(-2)}`;
  return token.replace(`[${inner}]`, `[${masked}]`);
}
