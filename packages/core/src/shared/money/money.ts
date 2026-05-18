import Decimal from 'decimal.js';

/**
 * Money — an immutable value object for Ghanaian Cedi amounts.
 *
 * Guiding principle #1 (DEVELOPMENT-PLAN.md §2): money is sacred. Amounts are
 * stored as integer pesewas (GHS × 100) in a bigint — never floats. Intermediate
 * math uses Decimal.js and rounds to whole pesewas with ROUND_HALF_UP.
 */
export type MoneyInput = Money | bigint | number | string;

const PESEWAS_PER_CEDI = 100n;

function toIntegerBigint(value: bigint | number | string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new TypeError(`Money: pesewas must be an integer, got ${value}`);
    }
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(`Money: ${value} exceeds the safe integer range`);
    }
    return BigInt(value);
  }
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new TypeError(`Money: invalid integer pesewas string "${value}"`);
  }
  return BigInt(trimmed);
}

export class Money {
  private constructor(private readonly _pesewas: bigint) {}

  /** Construct from whole pesewas (integer). */
  static fromPesewas(value: bigint | number | string): Money {
    return new Money(toIntegerBigint(value));
  }

  /** Construct from cedis; multiplies by 100 and rounds HALF_UP to pesewas. */
  static fromCedis(value: number | string): Money {
    const dec = new Decimal(typeof value === 'number' ? value : value.trim());
    if (!dec.isFinite()) {
      throw new RangeError(`Money.fromCedis: non-finite value "${value}"`);
    }
    const pesewas = dec.mul(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
    return new Money(BigInt(pesewas.toFixed(0)));
  }

  static zero(): Money {
    return new Money(0n);
  }

  /** Coerce any accepted input to Money (numbers/strings are treated as pesewas). */
  static from(value: MoneyInput): Money {
    return value instanceof Money ? value : Money.fromPesewas(value);
  }

  /** Canonical integer amount in pesewas. */
  get pesewas(): bigint {
    return this._pesewas;
  }

  /** Pesewas as a JS number. Throws if outside the safe integer range. */
  toNumber(): number {
    const n = Number(this._pesewas);
    if (!Number.isSafeInteger(n)) {
      throw new RangeError(`Money.toNumber: ${this._pesewas} exceeds the safe integer range`);
    }
    return n;
  }

  add(other: MoneyInput): Money {
    return new Money(this._pesewas + Money.from(other)._pesewas);
  }

  subtract(other: MoneyInput): Money {
    return new Money(this._pesewas - Money.from(other)._pesewas);
  }

  negate(): Money {
    return new Money(-this._pesewas);
  }

  /**
   * Multiply by a basis-points rate (400 bps = 4%) and round HALF_UP to whole
   * pesewas. Used for MDR, reserve, and interest math.
   */
  multiplyBps(bps: number): Money {
    if (!Number.isInteger(bps)) {
      throw new TypeError(`Money.multiplyBps: bps must be an integer, got ${bps}`);
    }
    const result = new Decimal(this._pesewas.toString())
      .mul(bps)
      .div(10000)
      .toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
    return new Money(BigInt(result.toFixed(0)));
  }

  compare(other: MoneyInput): -1 | 0 | 1 {
    const o = Money.from(other)._pesewas;
    if (this._pesewas < o) return -1;
    if (this._pesewas > o) return 1;
    return 0;
  }

  equals(other: MoneyInput): boolean {
    return this.compare(other) === 0;
  }

  greaterThan(other: MoneyInput): boolean {
    return this.compare(other) === 1;
  }

  lessThan(other: MoneyInput): boolean {
    return this.compare(other) === -1;
  }

  gte(other: MoneyInput): boolean {
    return this.compare(other) >= 0;
  }

  lte(other: MoneyInput): boolean {
    return this.compare(other) <= 0;
  }

  isZero(): boolean {
    return this._pesewas === 0n;
  }

  isPositive(): boolean {
    return this._pesewas > 0n;
  }

  isNegative(): boolean {
    return this._pesewas < 0n;
  }

  /** Human-readable, e.g. "GHS 1,234.56" (negatives as "-GHS 1,234.56"). */
  format(currencyCode = 'GHS'): string {
    const negative = this._pesewas < 0n;
    const abs = negative ? -this._pesewas : this._pesewas;
    const cedis = abs / PESEWAS_PER_CEDI;
    const fraction = (abs % PESEWAS_PER_CEDI).toString().padStart(2, '0');
    const grouped = cedis.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return `${negative ? '-' : ''}${currencyCode} ${grouped}.${fraction}`;
  }

  toString(): string {
    return this.format();
  }

  /** Serialize as the canonical pesewas string (bigint-safe for JSON). */
  toJSON(): string {
    return this._pesewas.toString();
  }
}
