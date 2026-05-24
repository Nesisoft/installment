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

const HUBTEL_DEFAULT_BASE_URL = 'https://smsc.hubtel.com';

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

    const p = (parsed ?? {}) as { messageId?: string; status?: number | string };
    const status: SmsStatus = p.status === 0 || p.status === 'success' ? 'queued' : 'sent';
    return { id: p.messageId, status, rawResponse: parsed };
  }
}
