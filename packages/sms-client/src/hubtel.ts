import {
  DEFAULT_TIMEOUT_MS,
  SmsError,
  type SmsClient,
  type SmsClientBaseOptions,
  type SmsMessage,
  type SmsResult,
  type SmsStatus,
} from './types';

export interface HubtelSmsOptions extends SmsClientBaseOptions {
  clientId: string;
  clientSecret: string;
  baseUrl?: string;
}

const HUBTEL_DEFAULT_BASE_URL = 'https://sms.hubtel.com';

/**
 * Hubtel SMS adapter — POST /v1/messages/send with HTTP Basic auth and a
 * `{ From, To, Content }` JSON body.
 */
export class HubtelSmsClient implements SmsClient {
  private readonly auth: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: HubtelSmsOptions) {
    if (!opts.clientId || !opts.clientSecret) {
      throw new Error('HubtelSmsClient: clientId and clientSecret are required');
    }
    this.auth = `Basic ${Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString('base64')}`;
    this.baseUrl = opts.baseUrl ?? HUBTEL_DEFAULT_BASE_URL;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async send(message: SmsMessage): Promise<SmsResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/messages/send`, {
        method: 'POST',
        headers: {
          Authorization: this.auth,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          From: message.sender,
          To: message.to,
          Content: message.message,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new SmsError('Network error calling Hubtel SMS', undefined, err);
    } finally {
      clearTimeout(timer);
    }

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      parsed = undefined;
    }

    if (!res.ok) {
      const message =
        (parsed as { message?: string } | undefined)?.message ??
        `Hubtel returned HTTP ${res.status}`;
      throw new SmsError(message, res.status, parsed);
    }

    const p = (parsed ?? {}) as {
      messageId?: string;
      status?: number | string;
      statusDescription?: string;
    };

    // Hubtel signals business-level rejections in the BODY, not the HTTP status:
    // an invalid destination, a barred sender id, rejected content or an
    // unfunded account all come back 201 with a non-zero `status`. Treating
    // those as delivered is how a `notifications` row ends up saying `sent` for
    // a message the customer never got — and for phone+OTP login, that is a
    // customer who cannot get in. Only `0` means accepted.
    if (p.status !== 0 && p.status !== 'success') {
      throw new SmsError(
        p.statusDescription ?? `Hubtel rejected the message (status ${String(p.status)})`,
        res.status,
        parsed,
      );
    }

    // `queued`, not `sent`: Hubtel has accepted it for onward delivery. Whether
    // it reached the handset is only known from the delivery receipt.
    const status: SmsStatus = 'queued';
    return { id: p.messageId, status, rawResponse: parsed };
  }
}
