import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * Narrow KV port for OTP storage. ioredis satisfies it structurally; keeping
 * it small means @installment/core needn't depend on a redis client.
 */
export interface OtpStore {
  set(key: string, value: string, ttlMs: number): Promise<void>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<void>;
}

export interface OtpOptions {
  /** Code lifetime in ms. Default 5 minutes. */
  ttlMs?: number;
  /** Number of digits. Default 6. */
  codeLength?: number;
  /** Verify attempts allowed before the code is burned. Default 5. */
  maxAttempts?: number;
  /** Namespacing prefix for store keys. Default 'otp:'. */
  keyPrefix?: string;
}

export interface OtpStartResult {
  /** Plaintext code — caller sends this via SMS, never persists it. */
  code: string;
  expiresAt: Date;
}

interface OtpRecord {
  hash: string;
  attempts: number;
  expiresAt: number;
}

const DEFAULTS = { ttlMs: 5 * 60_000, codeLength: 6, maxAttempts: 5, keyPrefix: 'otp:' };

function hashCode(target: string, code: string): string {
  return createHash('sha256').update(`${target}:${code}`).digest('hex');
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * One-time passcode issuance + verification, backed by an {@link OtpStore}.
 * The plaintext code is only ever returned from {@link start}; storage holds a
 * salted hash. Codes are burned after success or after maxAttempts failures.
 */
export class OtpService {
  private readonly ttlMs: number;
  private readonly codeLength: number;
  private readonly maxAttempts: number;
  private readonly keyPrefix: string;

  constructor(
    private readonly store: OtpStore,
    opts: OtpOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? DEFAULTS.ttlMs;
    this.codeLength = opts.codeLength ?? DEFAULTS.codeLength;
    this.maxAttempts = opts.maxAttempts ?? DEFAULTS.maxAttempts;
    this.keyPrefix = opts.keyPrefix ?? DEFAULTS.keyPrefix;
  }

  async start(target: string): Promise<OtpStartResult> {
    if (!target) throw new Error('OtpService.start: target is required');
    const max = 10 ** this.codeLength;
    const code = String(randomInt(0, max)).padStart(this.codeLength, '0');
    const expiresAt = Date.now() + this.ttlMs;
    const record: OtpRecord = { hash: hashCode(target, code), attempts: 0, expiresAt };
    await this.store.set(this.key(target), JSON.stringify(record), this.ttlMs);
    return { code, expiresAt: new Date(expiresAt) };
  }

  /**
   * Returns true on a correct, unexpired code (and burns it). Returns false on
   * mismatch (incrementing the attempt counter, burning after maxAttempts), on
   * an expired/absent code.
   */
  async verify(target: string, code: string): Promise<boolean> {
    const raw = await this.store.get(this.key(target));
    if (!raw) return false;

    const record = JSON.parse(raw) as OtpRecord;
    if (record.expiresAt <= Date.now()) {
      await this.store.del(this.key(target));
      return false;
    }

    if (constantTimeEquals(record.hash, hashCode(target, code))) {
      await this.store.del(this.key(target));
      return true;
    }

    record.attempts += 1;
    if (record.attempts >= this.maxAttempts) {
      await this.store.del(this.key(target));
    } else {
      const remainingTtl = record.expiresAt - Date.now();
      await this.store.set(this.key(target), JSON.stringify(record), remainingTtl);
    }
    return false;
  }

  private key(target: string): string {
    return `${this.keyPrefix}${target}`;
  }
}
