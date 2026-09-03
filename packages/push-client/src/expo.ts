import {
  DEFAULT_TIMEOUT_MS,
  DEVICE_NOT_REGISTERED,
  EXPO_TOKEN_PATTERN,
  PushError,
  type PushClient,
  type PushClientBaseOptions,
  type PushMessage,
  type PushResult,
} from './types';

export interface ExpoPushOptions extends PushClientBaseOptions {
  /**
   * Only needed when the Expo project enables "Enhanced Security for Push
   * Notifications". Unset is the normal case and sends unauthenticated, which
   * Expo accepts because a push token is itself the capability.
   */
  accessToken?: string;
  baseUrl?: string;
}

const EXPO_DEFAULT_BASE_URL = 'https://exp.host';

/** What Expo returns per message inside `data`. */
interface ExpoTicket {
  status?: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

/**
 * Expo push adapter — POST /--/api/v2/push/send with a JSON array of messages.
 *
 * Expo answers with a *ticket* per message, not a delivery: `status: 'ok'` plus
 * an id means Expo accepted it and will try FCM/APNs itself. Confirming actual
 * delivery is a second call against `/--/api/v2/push/getReceipts` with those
 * ids, which is a later slice — what matters here is telling apart the three
 * outcomes the caller must treat differently: accepted, refused for this token,
 * and could-not-ask.
 */
export class ExpoPushClient implements PushClient {
  private readonly accessToken?: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: ExpoPushOptions = {}) {
    this.accessToken = opts.accessToken?.trim() || undefined;
    this.baseUrl = opts.baseUrl ?? EXPO_DEFAULT_BASE_URL;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async send(message: PushMessage): Promise<PushResult> {
    // Refused here rather than at the API: a malformed token is a certain
    // rejection, and spending a network round trip to be told so just delays
    // the same answer.
    if (!EXPO_TOKEN_PATTERN.test(message.to)) {
      return {
        status: 'failed',
        error: 'InvalidPushToken',
        rawResponse: { to: message.to },
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/--/api/v2/push/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
        },
        body: JSON.stringify([
          {
            to: message.to,
            title: message.title,
            body: message.body,
            ...(message.data ? { data: message.data } : {}),
            sound: 'default',
            priority: 'high',
          },
        ]),
        signal: controller.signal,
      });
    } catch (err) {
      throw new PushError('Network error calling Expo push', undefined, err);
    } finally {
      clearTimeout(timer);
    }

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      parsed = undefined;
    }

    // A non-2xx is about the request, not the recipient — a bad access token,
    // a rate limit, Expo being down. The caller can retry those; it cannot
    // retry `DeviceNotRegistered`, so they must not look the same.
    if (!res.ok) {
      const message_ =
        (parsed as { errors?: { message?: string }[] } | undefined)?.errors?.[0]?.message ??
        `Expo push returned HTTP ${res.status}`;
      throw new PushError(message_, res.status, parsed);
    }

    const ticket = (parsed as { data?: ExpoTicket[] } | undefined)?.data?.[0];
    if (ticket?.status === 'ok') {
      return { id: ticket.id, status: 'sent', rawResponse: parsed };
    }

    return {
      status: 'failed',
      // `details.error` is the machine-readable one — DeviceNotRegistered,
      // MessageTooBig, MessageRateExceeded — and the caller keys on it.
      error: ticket?.details?.error ?? ticket?.message ?? 'UnknownExpoError',
      rawResponse: parsed,
    };
  }
}

export { DEVICE_NOT_REGISTERED };
