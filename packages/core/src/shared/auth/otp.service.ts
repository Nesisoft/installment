import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * Narrow KV port for OTP storage, kept small so @installment/core needn't
 * depend on a redis client. `del` and `incr` must be atomic: they are what
 * make a code single-use and the attempt cap a cap when guesses arrive
 * concurrently (`RedisOtpStore` maps them to DEL and an INCR script).
 */
export interface OtpStore {
  set(key: string, value: string, ttlMs: number): Promise<void>;
  get(key: string): Promise<string | null>;
  /** Removes the key; resolves to how many keys were removed (0 or 1). */
  del(key: string): Promise<number>;
  /** Adds one to a counter, creating it at 1 with `ttlMs` to live; resolves to the new value. */
  incr(key: string, ttlMs: number): Promise<number>;
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
 * salted hash. Codes are burned after success or after maxAttempts attempts.
 *
 * Verification used to read the record, compare, and write the attempt count
 * back — three steps with nothing holding them together. Guesses sent at once
 * all read the same count and each wrote back one more, so the five-attempt
 * cap allowed as many guesses as could be sent in parallel; two correct
 * verifies at once both succeeded; and a wrong guess that had read the record
 * before a correct one deleted it wrote it back, so a used code worked again.
 * Now each attempt is counted by an atomic increment before the code is
 * looked at, failures write nothing back, and a code is used by whichever
 * caller's delete actually removed it.
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
    const record: OtpRecord = { hash: hashCode(target, code), expiresAt };
    await this.store.set(this.key(target), JSON.stringify(record), this.ttlMs);
    // A new code gets a fresh count.
    await this.store.del(this.attemptsKey(target));
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
    const remainingTtl = record.expiresAt - Date.now();
    if (remainingTtl <= 0) {
      await this.burn(target);
      return false;
    }

    // Counted before the code is compared, so guesses that arrive together
    // each get their own number and the cap holds.
    const attempt = await this.store.incr(this.attemptsKey(target), remainingTtl);
    if (attempt > this.maxAttempts) {
      await this.burn(target);
      return false;
    }

    if (constantTimeEquals(record.hash, hashCode(target, code))) {
      // Whoever removes the code uses it; a concurrent second caller finds it
      // already gone.
      const consumed = await this.store.del(this.key(target));
      await this.store.del(this.attemptsKey(target));
      return consumed === 1;
    }

    if (attempt >= this.maxAttempts) await this.burn(target);
    return false;
  }

  private async burn(target: string): Promise<void> {
    await this.store.del(this.key(target));
    await this.store.del(this.attemptsKey(target));
  }

  private key(target: string): string {
    return `${this.keyPrefix}${target}`;
  }

  private attemptsKey(target: string): string {
    return `${this.keyPrefix}attempts:${target}`;
  }
}
