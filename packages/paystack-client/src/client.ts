import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Typed Paystack API wrapper for the installment engine.
 *
 * The HTTP method signatures cover what the MoMo orchestrator and the
 * settlement engine consume. Per Guiding principle #2 (Idempotency
 * everywhere), every mutating call accepts a deterministic `reference`
 * — Paystack treats a repeated reference as the same transaction.
 */

export type Currency = 'GHS';
export type MomoProvider = 'mtn' | 'tgo' | 'vod';

export interface PaystackResponse<T> {
  status: boolean;
  message: string;
  data: T;
}

export interface ChargeMobileMoneyRequest {
  email: string;
  /** Amount in pesewas (integer). */
  amount: number;
  currency: Currency;
  phone: string;
  provider: MomoProvider;
  /** Deterministic reference — repeat = same transaction. */
  reference: string;
  metadata?: Record<string, unknown>;
}

export interface ChargeCardRequest {
  email: string;
  amount: number;
  currency: Currency;
  authorization_code: string;
  reference: string;
  metadata?: Record<string, unknown>;
}

export interface ChargeData {
  reference: string;
  status: 'pay_offline' | 'success' | 'failed' | 'pending' | string;
  gateway_response?: string;
  display_text?: string;
  amount?: number;
  channel?: string;
}

export interface VerifyTransactionData {
  reference: string;
  status: 'success' | 'failed' | 'pending' | 'ongoing' | string;
  gateway_response?: string;
  amount?: number;
  paid_at?: string;
  channel?: string;
}

export interface CreatePaymentLinkRequest {
  email: string;
  amount: number;
  currency: Currency;
  reference: string;
  callback_url?: string;
  metadata?: Record<string, unknown>;
}

export interface CreatePaymentLinkData {
  reference: string;
  access_code: string;
  authorization_url: string;
}

export interface InitiateTransferRequest {
  source: 'balance';
  /** Amount in pesewas (integer). */
  amount: number;
  /** Paystack recipient code (merchant.paystack_recipient_code). */
  recipient: string;
  reason: string;
  reference: string;
}

export interface TransferData {
  transfer_code: string;
  reference: string;
  status: 'success' | 'failed' | 'pending' | 'otp' | 'reversed' | string;
  amount?: number;
}

export interface RefundRequest {
  /**
   * The transaction being refunded — Paystack accepts its reference or its
   * numeric id. Note that a refund carries no client-supplied reference of its
   * own, so a retry cannot be made idempotent by reference the way a transfer
   * can: callers must key idempotency on their own record.
   */
  transaction: string;
  /** Amount in pesewas (integer). Omit to refund the full transaction. */
  amount?: number;
  currency?: Currency;
  /** Shown to the customer. */
  customer_note?: string;
  /** Internal note, visible on the Paystack dashboard. */
  merchant_note?: string;
}

export interface RefundData {
  /** Paystack's id for the refund itself, needed to verify it later. */
  id: number | string;
  /** pending | processing | processed | failed */
  status: string;
  amount?: number;
  currency?: string;
  transaction?: { reference?: string; id?: number | string };
}

export class PaystackError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'PaystackError';
  }
}

export interface PaystackClientOptions {
  secretKey: string;
  baseUrl?: string;
  /** Defaults to global fetch; tests inject a stub. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = 'https://api.paystack.co';
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Paystack's documented reference charset: alphanumerics plus `-`, `.` and `=`.
 * A reference outside it is rejected by the API, which would surface here as a
 * generic failure and park the attempt in `unknown` — indistinguishable from a
 * network fault. Validating at the boundary turns a silent, systemic outage
 * into an obvious programming error at the call site.
 */
const REFERENCE_PATTERN = /^[A-Za-z0-9.=-]{1,100}$/;

function assertValidReference(op: string, reference: string): void {
  if (!REFERENCE_PATTERN.test(reference)) {
    throw new PaystackError(
      `${op}: reference "${reference}" is not a valid Paystack reference ` +
        `(allowed: letters, digits, "-", ".", "=", max 100 chars)`,
    );
  }
}

export class PaystackClient {
  private readonly secretKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: PaystackClientOptions) {
    if (!opts.secretKey) {
      throw new Error('PaystackClient: secretKey is required');
    }
    this.secretKey = opts.secretKey;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Validates a Paystack webhook signature.
   * Algorithm: HMAC-SHA512 hex of the raw body, keyed by the merchant
   * secret key, compared in constant time to the `x-paystack-signature`
   * header. Must be called on the *raw* request body (no re-stringify).
   */
  verifySignature(rawBody: string | Buffer | Uint8Array, signature: string): boolean {
    if (!signature) return false;
    const bodyBuf = Buffer.isBuffer(rawBody)
      ? rawBody
      : typeof rawBody === 'string'
        ? Buffer.from(rawBody, 'utf8')
        : Buffer.from(rawBody);
    const expectedHex = createHmac('sha512', this.secretKey).update(bodyBuf).digest('hex');
    const a = Buffer.from(expectedHex, 'utf8');
    const b = Buffer.from(signature, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  chargeMobileMoney(req: ChargeMobileMoneyRequest): Promise<PaystackResponse<ChargeData>> {
    assertValidReference('chargeMobileMoney', req.reference);
    return this.request<ChargeData>('POST', '/charge', {
      email: req.email,
      amount: req.amount,
      currency: req.currency,
      reference: req.reference,
      mobile_money: { phone: req.phone, provider: req.provider },
      metadata: req.metadata,
    });
  }

  chargeCard(req: ChargeCardRequest): Promise<PaystackResponse<ChargeData>> {
    assertValidReference('chargeCard', req.reference);
    return this.request<ChargeData>('POST', '/charge', {
      email: req.email,
      amount: req.amount,
      currency: req.currency,
      reference: req.reference,
      authorization_code: req.authorization_code,
      metadata: req.metadata,
    });
  }

  verifyTransaction(reference: string): Promise<PaystackResponse<VerifyTransactionData>> {
    if (!reference) throw new PaystackError('verifyTransaction: reference is required');
    return this.request<VerifyTransactionData>(
      'GET',
      `/transaction/verify/${encodeURIComponent(reference)}`,
    );
  }

  createPaymentLink(
    req: CreatePaymentLinkRequest,
  ): Promise<PaystackResponse<CreatePaymentLinkData>> {
    assertValidReference('createPaymentLink', req.reference);
    return this.request<CreatePaymentLinkData>('POST', '/transaction/initialize', {
      email: req.email,
      amount: req.amount,
      currency: req.currency,
      reference: req.reference,
      callback_url: req.callback_url,
      metadata: req.metadata,
    });
  }

  initiateTransfer(req: InitiateTransferRequest): Promise<PaystackResponse<TransferData>> {
    return this.request<TransferData>('POST', '/transfer', req);
  }

  verifyTransfer(reference: string): Promise<PaystackResponse<TransferData>> {
    if (!reference) throw new PaystackError('verifyTransfer: reference is required');
    return this.request<TransferData>('GET', `/transfer/verify/${encodeURIComponent(reference)}`);
  }

  /**
   * Returns money to the customer on the original transaction.
   *
   * The `transaction` is validated against the reference charset for the same
   * reason charges are: an unusable reference would surface as a generic
   * failure and park the refund in `unknown`, indistinguishable from a network
   * fault, on the one operation where the customer is waiting for their money.
   */
  refund(req: RefundRequest): Promise<PaystackResponse<RefundData>> {
    assertValidReference('refund', req.transaction);
    return this.request<RefundData>('POST', '/refund', {
      transaction: req.transaction,
      amount: req.amount,
      currency: req.currency,
      customer_note: req.customer_note,
      merchant_note: req.merchant_note,
    });
  }

  /** Fetches one refund by the id Paystack returned from {@link refund}. */
  verifyRefund(refundId: string): Promise<PaystackResponse<RefundData>> {
    if (!refundId) throw new PaystackError('verifyRefund: refundId is required');
    return this.request<RefundData>('GET', `/refund/${encodeURIComponent(refundId)}`);
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<PaystackResponse<T>> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      throw new PaystackError(`Network error calling Paystack ${method} ${path}`, undefined, err);
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
        `Paystack ${method} ${path} returned HTTP ${res.status}`;
      throw new PaystackError(message, res.status, parsed);
    }

    return parsed as PaystackResponse<T>;
  }
}
