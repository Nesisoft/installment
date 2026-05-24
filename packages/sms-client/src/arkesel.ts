import {
  DEFAULT_TIMEOUT_MS,
  SmsError,
  type SmsClient,
  type SmsClientBaseOptions,
  type SmsMessage,
  type SmsResult,
  type SmsStatus,
} from './types';

export interface ArkeselSmsOptions extends SmsClientBaseOptions {
  apiKey: string;
  baseUrl?: string;
}

const ARKESEL_DEFAULT_BASE_URL = 'https://sms.arkesel.com';

/**
 * Arkesel v2 SMS adapter — POST /api/v2/sms/send with header `api-key` and
 * JSON `{ sender, recipients: [to], message }`.
 */
export class ArkeselSmsClient implements SmsClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: ArkeselSmsOptions) {
    if (!opts.apiKey) {
      throw new Error('ArkeselSmsClient: apiKey is required');
    }
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? ARKESEL_DEFAULT_BASE_URL;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async send(message: SmsMessage): Promise<SmsResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/api/v2/sms/send`, {
        method: 'POST',
        headers: {
          'api-key': this.apiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          sender: message.sender,
          recipients: [message.to],
          message: message.message,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new SmsError('Network error calling Arkesel SMS', undefined, err);
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
        `Arkesel returned HTTP ${res.status}`;
      throw new SmsError(message, res.status, parsed);
    }

    const p = (parsed ?? {}) as {
      status?: string;
      code?: string;
      data?: Array<{ id?: string; recipient?: string }>;
    };
    if (p.status && p.status !== 'success') {
      throw new SmsError(`Arkesel returned status "${p.status}"`, res.status, parsed);
    }
    const first = p.data?.[0];
    const status: SmsStatus = 'queued';
    return { id: first?.id, status, rawResponse: parsed };
  }
}
