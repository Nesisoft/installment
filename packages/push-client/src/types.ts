/**
 * Common surface for a push provider, mirroring `@installment/sms-client`.
 *
 * The orchestration layer talks to {@link PushClient} so the provider is
 * interchangeable — a console implementation locally, Expo in production, and
 * a stub in tests — without anything upstream knowing which it is.
 */

export interface PushMessage {
  /** Expo push token: `ExponentPushToken[…]` or `ExpoPushToken[…]`. */
  to: string;
  title: string;
  body: string;
  /** Delivered to the app as `notification.request.content.data`. */
  data?: Record<string, unknown>;
}

export type PushStatus = 'sent' | 'failed';

export interface PushResult {
  /** Provider's receipt id where available, for a later delivery check. */
  id?: string;
  status: PushStatus;
  /**
   * Why the provider refused this one. `DeviceNotRegistered` is the important
   * value: the handset has uninstalled the app or the token has rotated, and
   * the caller should stop sending to it rather than retrying forever.
   */
  error?: string;
  rawResponse: unknown;
}

export interface PushClient {
  /**
   * Send to one token. Never throws for a per-message refusal — that comes back
   * as `status: 'failed'` with `error` — because a notification must not be
   * able to break the flow that triggered it. A transport failure (the provider
   * unreachable) does throw {@link PushError}, so the caller can tell "they did
   * not want this message" from "we could not ask".
   */
  send(message: PushMessage): Promise<PushResult>;
}

export class PushError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'PushError';
  }
}

export interface PushClientBaseOptions {
  /** Defaults to global fetch; tests inject a stub. */
  fetchImpl?: typeof fetch;
  /** Per-request abort timeout. Default 15s. */
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 15_000;

/** Expo's own token shapes. Anything else is not worth a network call. */
export const EXPO_TOKEN_PATTERN = /^(ExponentPushToken\[.+\]|ExpoPushToken\[.+\])$/;

/**
 * The provider's word for "stop sending to this token".
 *
 * Worth a named constant because it is the one error that means something to
 * the database rather than to a log: a device that reports it should be
 * deactivated, or every subsequent send burns a request on a handset that has
 * uninstalled the app.
 */
export const DEVICE_NOT_REGISTERED = 'DeviceNotRegistered';
