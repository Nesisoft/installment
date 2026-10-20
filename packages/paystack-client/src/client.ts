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

/**
 * The saved-card handle Paystack returns alongside a successful card charge.
 *
 * `authorization_code` is the credential: presenting it charges the card again
 * without the cardholder present. `reusable` is the part that matters most —
 * Paystack marks some authorizations single-use, and charging one of those
 * simply fails, so it must be checked before anything is stored for reuse.
 */
export interface PaystackAuthorization {
  authorization_code: string;
  /** Fingerprint of the underlying card: the same card re-tokenised repeats it. */
  signature?: string;
  last4?: string;
  brand?: string;
  card_type?: string;
  bank?: string;
  exp_month?: string;
  exp_year?: string;
  channel?: string;
  country_code?: string;
  reusable?: boolean;
}

export interface ChargeData {
  reference: string;
  status: 'pay_offline' | 'success' | 'failed' | 'pending' | string;
  gateway_response?: string;
  display_text?: string;
  amount?: number;
  channel?: string;
  authorization?: PaystackAuthorization;
}

export interface VerifyTransactionData {
  /** Paystack's numeric id for the transaction — what its refund list is keyed by. */
  id?: number;
  reference: string;
  status: 'success' | 'failed' | 'pending' | 'ongoing' | string;
  gateway_response?: string;
  amount?: number;
  paid_at?: string;
  channel?: string;
  authorization?: PaystackAuthorization;
}

/**
 * Payment channels Paystack may offer on the hosted page.
 *
 * Worth restricting rather than leaving to Paystack's default of "everything":
 * this app charges Mobile Money natively, in-app, with no page to leave — so
 * offering MoMo on the hosted page too would present a worse version of a
 * journey the customer already has, and split the same payment method across
 * two code paths that settle differently.
 */
export type PaystackChannel = 'card' | 'mobile_money' | 'bank' | 'ussd' | 'bank_transfer' | 'qr';

export interface CreatePaymentLinkRequest {
  email: string;
  amount: number;
  currency: Currency;
  reference: string;
  callback_url?: string;
  /** Omit to accept Paystack's account-level default. */
  channels?: PaystackChannel[];
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

/**
 * A destination Paystack can send money to. In Ghana the list mixes bank
 * accounts (`type: "ghipss"`, settled over the GhIPSS rails) with mobile-money
 * wallets (`type: "mobile_money"`) — the same picker covers both, and the type
 * is what a transfer recipient has to be created as.
 */
export interface BankData {
  name: string;
  slug: string;
  code: string;
  currency: string;
  type: string;
  active?: boolean;
}

export interface ResolvedAccountData {
  account_number: string;
  /** The name the bank holds for the account — not what the applicant typed. */
  account_name: string;
  bank_id?: number;
}

export type TransferRecipientType = 'ghipss' | 'mobile_money' | 'nuban';

export interface CreateTransferRecipientRequest {
  type: TransferRecipientType;
  /** Shown on the transfer; use the name the bank resolved, not user input. */
  name: string;
  account_number: string;
  bank_code: string;
  currency: Currency;
}

export interface TransferRecipientData {
  recipient_code: string;
  type: string;
  active?: boolean;
  details?: {
    account_number?: string;
    account_name?: string | null;
    bank_code?: string;
    bank_name?: string;
  };
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
  /**
   * The refunded charge. An object when a refund is created; a bare numeric id
   * when one is fetched or listed (both seen in test mode).
   */
  transaction?: { reference?: string; id?: number | string } | number;
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
      ...(req.channels?.length ? { channels: req.channels } : {}),
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

  /**
   * Every destination the account may pay out to, for the picker a merchant
   * chooses from. Ghana's list is long but static enough that callers should
   * cache it rather than fetch it per page view.
   */
  listBanks(currency: Currency = 'GHS'): Promise<PaystackResponse<BankData[]>> {
    return this.request<BankData[]>(
      'GET',
      `/bank?currency=${encodeURIComponent(currency)}&perPage=100`,
    );
  }

  /**
   * Asks the bank who owns an account number.
   *
   * This is what makes a self-served payout account safe to accept: the name
   * comes back from the bank, so a typo lands on a stranger's name the payee
   * can see and reject, rather than on a successful transfer to the wrong
   * person.
   */
  resolveAccount(
    accountNumber: string,
    bankCode: string,
  ): Promise<PaystackResponse<ResolvedAccountData>> {
    if (!accountNumber) throw new PaystackError('resolveAccount: accountNumber is required');
    if (!bankCode) throw new PaystackError('resolveAccount: bankCode is required');
    return this.request<ResolvedAccountData>(
      'GET',
      `/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`,
    );
  }

  /**
   * Registers a destination and returns the `recipient_code` a transfer needs.
   *
   * Paystack deduplicates on (type, account_number, bank_code), so calling this
   * again for an account already registered returns the existing recipient
   * rather than a second one.
   */
  createTransferRecipient(
    req: CreateTransferRecipientRequest,
  ): Promise<PaystackResponse<TransferRecipientData>> {
    return this.request<TransferRecipientData>('POST', '/transferrecipient', {
      type: req.type,
      name: req.name,
      account_number: req.account_number,
      bank_code: req.bank_code,
      currency: req.currency,
    });
  }

  /**
   * Every refund raised against one charge — how a refund whose response was
   * lost finds its provider id again.
   *
   * By Paystack's NUMERIC transaction id only (from {@link verifyTransaction}).
   * Checked against test mode: `?transaction=<reference>` answers `status: true`
   * with an empty list rather than an error, so a lookup by reference reads as
   * "no refund exists" — and a caller acting on that would refund twice. The
   * argument is refused unless it is all digits.
   */
  listRefundsForTransaction(
    transactionId: number | string,
  ): Promise<PaystackResponse<RefundData[]>> {
    const id = String(transactionId);
    if (!/^\d+$/.test(id)) {
      throw new PaystackError(
        `listRefundsForTransaction: "${id}" is not a numeric Paystack transaction id`,
      );
    }
    return this.request<RefundData[]>('GET', `/refund?transaction=${id}`);
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
